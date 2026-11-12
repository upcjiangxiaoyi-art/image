import { createSegmentedBackend } from './segmented-backend.js';
import { sharedSegmentCache } from './segment-cache.js';
import { createTavernFiles } from './tavern-files.js';

/* 生成记录（attempt）的独立存储：和画廊元数据一样放在当前 ST 用户文件里，不再写进聊天。
   聊天里每一楼只留标签本身和图片引用；谁画过、画了多久、报了什么错都在这份文件里，按 tagId 关联。
   - 写入会合并：同一拍里的多次 put 只落一次盘；put() 返回的 promise 在这份记录真正写进文件后才 resolve，
     发上游请求之前要等它（防重复记录）。进度更新（下载中、保存中）只改内存，不落盘。
   - 有上限：每个标签最多留 MAX_ATTEMPTS_PER_TAG 条、总共最多 MAX_ATTEMPTS_TOTAL 条，超过就删最早结束的；
     还在画的不删。
   - 2.4.0 起和画廊索引一样拆成「一份清单 + 若干小文件」：记一笔只重写它所在的那一小份。
     ATTEMPT_STORE_FILE 是 2.4.0 之前的整份文件，第一次打开时拆开，之后留在原地不再读写。 */
export const ATTEMPT_STORE_FILE = 'st-image-atelier-attempts.json';
export const ATTEMPT_INDEX_FILE = 'st-image-atelier-attempts-index.json';
export const ATTEMPT_SEGMENT_PREFIX = 'st-image-atelier-attempts-';
export const ATTEMPT_SEGMENT_BYTES = 96_000;
export const ATTEMPT_SEGMENT_RECORDS = 80;
export const MAX_ATTEMPTS_PER_TAG = 20;
export const MAX_ATTEMPTS_TOTAL = 2000;
/* 总数超出上限这么多条才清一次、一次清回上限：不然满了以后每记一笔都要删一条最早的，
   最早那个分片也就每次都要跟着重写。 */
export const ATTEMPT_PRUNE_SLACK = 100;
const DOCUMENT_SCHEMA_VERSION = 1;
const ACTIVE_STATUSES = new Set(['queued', 'generating', 'downloading', 'saving']);

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function emptyDocument() {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    attempts: {},
    updatedAt: new Date().toISOString(),
  };
}

function createdAtOf(attempt) {
  return String(attempt?.createdAt || '');
}

/* 最近开始的排前面；同一毫秒开始的按写入顺序倒过来（后写的在前），和以前聊天里 unshift 的顺序一致。 */
function newestFirst(list) {
  return [...list].reverse().sort((left, right) => createdAtOf(right).localeCompare(createdAtOf(left)));
}

function oldestFirst(list) {
  return newestFirst(list).reverse();
}

export function createAttemptStore({
  readDocument,
  writeDocument,
  perTagLimit = MAX_ATTEMPTS_PER_TAG,
  totalLimit = MAX_ATTEMPTS_TOTAL,
  /* 总数超过 totalLimit + totalSlack 才清，一次清回 totalLimit。 */
  totalSlack = 0,
  flushDelayMs = 0,
  /* 给分片存储用：哪条记录变了、内存里那份活的文档是哪个。 */
  noteChange,
  attach,
  expedite,
}) {
  let document = null;
  let initializePromise = null;
  let writeChain = Promise.resolve();
  let pending = null;
  const byTag = new Map();
  const mark = typeof noteChange === 'function' ? noteChange : () => {};

  function index(attempt) {
    if (!byTag.has(attempt.tagId)) byTag.set(attempt.tagId, new Set());
    byTag.get(attempt.tagId).add(attempt.attemptId);
  }

  function unindex(attempt) {
    const ids = byTag.get(attempt?.tagId);
    if (!ids) return;
    ids.delete(attempt.attemptId);
    if (!ids.size) byTag.delete(attempt.tagId);
  }

  function normalizeDocument(value) {
    const next = emptyDocument();
    const source = value?.attempts && typeof value.attempts === 'object' && !Array.isArray(value.attempts)
      ? Object.values(value.attempts)
      : [];
    for (const item of source) {
      if (!item?.attemptId || !item?.tagId) continue;
      next.attempts[item.attemptId] = item;
    }
    next.updatedAt = String(value?.updatedAt || next.updatedAt);
    return next;
  }

  function ready() {
    if (!document) throw new Error('Attempt store is not initialized');
  }

  async function initialize() {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      const raw = await readDocument();
      document = normalizeDocument(raw);
      byTag.clear();
      for (const attempt of Object.values(document.attempts)) index(attempt);
      attach?.(document);
      return api;
    })();
    try {
      return await initializePromise;
    } catch (error) {
      initializePromise = null;
      document = null;
      throw error;
    }
  }

  /* 把现在内存里的整份文档排进写队列：flushDelayMs 内的多次调用合成一次写（出图返回那一瞬间别和酒馆存聊天、
     画廊写文件挤在一起）；immediate 是发上游请求前的防重复记录，等不得，当拍就写。返回的 promise 在写完后
     resolve。写的时候直接序列化内存里的文档，不再整份深拷贝一遍。 */
  function fire(entry) {
    if (pending === entry) pending = null;
    const write = writeChain.then(() => {
      document.updatedAt = new Date().toISOString();
      return writeDocument(document);
    });
    write.then(entry.resolve, entry.reject);
    writeChain = write.catch(() => {});
  }

  function scheduleFlush({ immediate = false } = {}) {
    if (pending) {
      const entry = pending;
      if (immediate) {
        clearTimeout(entry.timer);
        fire(entry);
      }
      return entry.promise;
    }
    const entry = {};
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    pending = entry;
    /* immediate 当场排进写队列，不绕定时器：页面转入后台时定时器可能再也不跑。 */
    if (immediate) fire(entry);
    else entry.timer = setTimeout(() => fire(entry), flushDelayMs);
    return entry.promise;
  }

  function removeLocal(attemptId) {
    const attempt = document.attempts[attemptId];
    if (!attempt) return false;
    unindex(attempt);
    delete document.attempts[attemptId];
    mark(attemptId);
    return true;
  }

  function listOf(tagId) {
    const ids = byTag.get(tagId);
    return ids ? [...ids].map(id => document.attempts[id]).filter(Boolean) : [];
  }

  /* 超过上限就删最早结束的；还在画的不动。返回删掉的 attemptId。 */
  function prune(touchedTagIds = []) {
    const removed = [];
    const dropFrom = (list, keep) => {
      const finished = oldestFirst(list).filter(item => !ACTIVE_STATUSES.has(item.status));
      const excess = list.length - keep;
      for (const item of finished.slice(0, Math.max(0, excess))) {
        if (removeLocal(item.attemptId)) removed.push(item.attemptId);
      }
    };
    for (const tagId of new Set(touchedTagIds)) {
      const list = listOf(tagId);
      if (list.length > perTagLimit) dropFrom(list, perTagLimit);
    }
    const all = Object.values(document.attempts);
    if (all.length > totalLimit + totalSlack) dropFrom(all, totalLimit);
    return removed;
  }

  function putLocal(attempt) {
    if (!attempt?.attemptId || !attempt?.tagId) throw new Error('生成记录缺少 attemptId 或 tagId');
    const previous = document.attempts[attempt.attemptId];
    if (previous && previous.tagId !== attempt.tagId) unindex(previous);
    document.attempts[attempt.attemptId] = clone(attempt);
    index(document.attempts[attempt.attemptId]);
    mark(attempt.attemptId);
  }

  const api = {
    initialize,
    get(attemptId) {
      ready();
      const value = document.attempts[attemptId];
      return value ? clone(value) : null;
    },
    has(attemptId) {
      ready();
      return Boolean(document.attempts[attemptId]);
    },
    forTag(tagId) {
      ready();
      return newestFirst(listOf(tagId)).map(clone);
    },
    values() {
      ready();
      return Object.values(document.attempts).map(clone);
    },
    get size() {
      ready();
      return Object.keys(document.attempts).length;
    },
    /* persist=false：只改内存（进度更新），等下一次真正的写入顺带带上。immediate：当拍就写。 */
    put(attempt, { persist = true, immediate = false } = {}) {
      ready();
      putLocal(attempt);
      prune([attempt.tagId]);
      return persist ? scheduleFlush({ immediate }) : Promise.resolve();
    },
    putMany(attempts, { persist = true, immediate = false } = {}) {
      ready();
      const list = (attempts || []).filter(item => item?.attemptId && item?.tagId);
      for (const item of list) putLocal(item);
      prune(list.map(item => item.tagId));
      if (!list.length) return Promise.resolve();
      return persist ? scheduleFlush({ immediate }) : Promise.resolve();
    },
    remove(attemptId) {
      ready();
      return removeLocal(attemptId) ? scheduleFlush() : Promise.resolve();
    },
    removeForTag(tagId) {
      ready();
      const ids = [...(byTag.get(tagId) || [])];
      for (const id of ids) removeLocal(id);
      return ids.length ? scheduleFlush() : Promise.resolve();
    },
    /* 等写完；还在等合并写的立刻写。 */
    flush() {
      expedite?.();
      return pending ? scheduleFlush({ immediate: true }) : writeChain;
    },
  };
  return api;
}

/* 终态记录（画完、失败）不急：2 秒内的几次写合成一次，也错开出图返回那一瞬间；发请求前的那次用 immediate。 */
export const ATTEMPT_FLUSH_DELAY_MS = 2000;

/* 酒馆用户文件里的生成记录。options 和画廊索引那边一样：flushDelayMs、cache、segmentBytes、segmentRecords，
   再加 createAttemptStore 的上限参数。返回的存储多一个 storage（status()、whenIdle()）。 */
export function createSillyTavernAttemptStore(compat, fetchImpl = globalThis.fetch, options = {}) {
  const {
    cache = sharedSegmentCache(),
    segmentBytes = ATTEMPT_SEGMENT_BYTES,
    segmentRecords = ATTEMPT_SEGMENT_RECORDS,
    backend: backendOptions = {},
    ...storeOptions
  } = options;
  const backend = createSegmentedBackend({
    files: createTavernFiles(compat, fetchImpl, { cache, label: '生成记录' }),
    label: '生成记录',
    manifestFile: ATTEMPT_INDEX_FILE,
    segmentPrefix: ATTEMPT_SEGMENT_PREFIX,
    legacyFile: ATTEMPT_STORE_FILE,
    recordsKey: 'attempts',
    legacyRecords: value => (value?.attempts && typeof value.attempts === 'object' && !Array.isArray(value.attempts)
      ? Object.values(value.attempts)
      : []),
    idOf: attempt => attempt?.attemptId,
    orderOf: attempt => attempt?.createdAt,
    maxSegmentBytes: segmentBytes,
    maxSegmentRecords: segmentRecords,
    /* 手机网络抖一下就整个初始化失败太亏：读分片失败先重试两次。 */
    retryDelaysMs: [300, 1200],
    ...backendOptions,
  });
  const store = createAttemptStore({
    flushDelayMs: ATTEMPT_FLUSH_DELAY_MS,
    totalSlack: ATTEMPT_PRUNE_SLACK,
    ...storeOptions,
    readDocument: backend.readDocument,
    writeDocument: backend.writeDocument,
    noteChange: backend.noteChange,
    attach: backend.attach,
    expedite: backend.expedite,
  });
  store.storage = backend;
  return store;
}

export function createMemoryAttemptStore(initialDocument = null, options = {}) {
  let document = initialDocument ? clone(initialDocument) : emptyDocument();
  let writes = 0;
  const store = createAttemptStore({
    ...options,
    readDocument: async () => clone(document),
    writeDocument: async value => {
      writes += 1;
      document = clone(value);
    },
  });
  Object.defineProperty(store, 'document', { get: () => clone(document) });
  Object.defineProperty(store, 'writes', { get: () => writes });
  return store;
}
