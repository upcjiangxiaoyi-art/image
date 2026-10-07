import { DirectError, bytesToBase64 } from './openai-direct.js';

/* 生成记录（attempt）的独立存储：和画廊元数据一样放在当前 ST 用户文件里，不再写进聊天。
   聊天里每一楼只留标签本身和图片引用；谁画过、画了多久、报了什么错都在这份文件里，按 tagId 关联。
   - 写入会合并：同一拍里的多次 put 只落一次盘；put() 返回的 promise 在这份记录真正写进文件后才 resolve，
     发上游请求之前要等它（防重复记录）。进度更新（下载中、保存中）只改内存，不落盘。
   - 有上限：每个标签最多留 MAX_ATTEMPTS_PER_TAG 条、整份文件最多 MAX_ATTEMPTS_TOTAL 条，超过就删最早结束的；
     还在画的不删。 */
export const ATTEMPT_STORE_FILE = 'st-image-atelier-attempts.json';
export const ATTEMPT_STORE_URL = `/user/files/${ATTEMPT_STORE_FILE}`;
export const MAX_ATTEMPTS_PER_TAG = 20;
export const MAX_ATTEMPTS_TOTAL = 2000;
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
  flushDelayMs = 0,
}) {
  let document = null;
  let initializePromise = null;
  let writeChain = Promise.resolve();
  let pending = null;
  const byTag = new Map();

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

  /* 把现在内存里的整份文档排进写队列；同一拍里的多次调用共用一次写。返回的 promise 在写完后 resolve。 */
  function scheduleFlush() {
    if (pending) return pending.promise;
    const entry = {};
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    pending = entry;
    setTimeout(() => {
      if (pending === entry) pending = null;
      const snapshot = clone(document);
      snapshot.updatedAt = new Date().toISOString();
      const write = writeChain.then(() => writeDocument(snapshot));
      write.then(entry.resolve, entry.reject);
      writeChain = write.catch(() => {});
    }, flushDelayMs);
    return entry.promise;
  }

  function removeLocal(attemptId) {
    const attempt = document.attempts[attemptId];
    if (!attempt) return false;
    unindex(attempt);
    delete document.attempts[attemptId];
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
    if (all.length > totalLimit) dropFrom(all, totalLimit);
    return removed;
  }

  function putLocal(attempt) {
    if (!attempt?.attemptId || !attempt?.tagId) throw new Error('生成记录缺少 attemptId 或 tagId');
    const previous = document.attempts[attempt.attemptId];
    if (previous && previous.tagId !== attempt.tagId) unindex(previous);
    document.attempts[attempt.attemptId] = clone(attempt);
    index(document.attempts[attempt.attemptId]);
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
    /* persist=false：只改内存（进度更新），等下一次真正的写入顺带带上。 */
    put(attempt, { persist = true } = {}) {
      ready();
      putLocal(attempt);
      prune([attempt.tagId]);
      return persist ? scheduleFlush() : Promise.resolve();
    },
    putMany(attempts, { persist = true } = {}) {
      ready();
      const list = (attempts || []).filter(item => item?.attemptId && item?.tagId);
      for (const item of list) putLocal(item);
      prune(list.map(item => item.tagId));
      if (!list.length) return Promise.resolve();
      return persist ? scheduleFlush() : Promise.resolve();
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
    flush() {
      return pending ? pending.promise : writeChain;
    },
  };
  return api;
}

export function createSillyTavernAttemptStore(compat, fetchImpl = globalThis.fetch, options = {}) {
  return createAttemptStore({
    ...options,
    async readDocument() {
      const response = await fetchImpl(`${ATTEMPT_STORE_URL}?t=${Date.now()}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 404) return emptyDocument();
      if (!response.ok) {
        throw new DirectError('LOCAL_SAVE_FAILED', `读取生成记录失败（HTTP ${response.status}）`, response.status);
      }
      try {
        return await response.json();
      } catch {
        throw new DirectError('LOCAL_SAVE_FAILED', '生成记录文件不是有效 JSON');
      }
    },
    async writeDocument(document) {
      const bytes = new TextEncoder().encode(JSON.stringify(document));
      const response = await fetchImpl('/api/files/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: compat.headers(),
        body: JSON.stringify({
          name: ATTEMPT_STORE_FILE,
          data: bytesToBase64(bytes),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new DirectError(
          'LOCAL_SAVE_FAILED',
          payload?.error || `写入生成记录失败（HTTP ${response.status}）`,
          response.status,
        );
      }
    },
  });
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
