import { SCHEMA_VERSION } from '../../shared/constants.js';
import { createSegmentedBackend } from './segmented-backend.js';
import { sharedSegmentCache } from './segment-cache.js';
import { createTavernFiles } from './tavern-files.js';

/* 2.4.0 起画廊索引拆成「一份清单 + 若干小文件」：改一张图的记录只重写它所在的那一小份。
   GALLERY_METADATA_FILE 是 2.4.0 之前的整份文件，第一次打开时拆开，之后留在原地当备份，不再读写。 */
export const GALLERY_METADATA_FILE = 'st-image-atelier-gallery.json';
export const GALLERY_INDEX_FILE = 'st-image-atelier-gallery-index.json';
export const GALLERY_SEGMENT_PREFIX = 'st-image-atelier-gallery-';
/* 一个分片最多这么多字节、这么多条：提示词长的时候十几张图一份，短的时候一百来张一份。
   上限小，出一张图要上传的就少；上限大，分片个数少，打开页面时要问服务器的次数就少。 */
export const GALLERY_SEGMENT_BYTES = 160_000;
export const GALLERY_SEGMENT_RECORDS = 150;
const DOCUMENT_SCHEMA_VERSION = 1;
/* 出图返回那一瞬间酒馆自己要存聊天、要重画，画廊文件晚 1.5 秒再写，几张图连着出也只写一次。 */
export const GALLERY_FLUSH_DELAY_MS = 1500;

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function normalizeGalleryRecord(value = {}) {
  const {
    promptSnapshot,
    resolvedPrompt,
    negativePromptSnapshot,
    resolvedNegativePrompt,
    deletedAt,
    ...rest
  } = value;
  const provider = value.provider === 'novelai'
    || value.presetId === 'novelai'
    || value.artistPresetId
    ? 'novelai'
    : 'openai';
  return {
    ...rest,
    prompt: String(promptSnapshot || value.prompt || resolvedPrompt || ''),
    negativePrompt: String(negativePromptSnapshot || value.negativePrompt || resolvedNegativePrompt || ''),
    favorite: value.favorite === true,
    provider,
    status: 'available',
    schemaVersion: SCHEMA_VERSION,
  };
}

function emptyDocument() {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    results: {},
    updatedAt: new Date().toISOString(),
  };
}

/* 兼容两种落盘格式：
   - 本实现：{ schemaVersion, results: { [resultId]: record }, updatedAt }
   - fork 1.6.2（2026-09-13 起已有用户迁移过去）：{ version, items: [record] }，
     记录字段是 promptSnapshot / negativePromptSnapshot。
   同名文件，读不出来就会被空文档覆盖、整个画廊消失，所以两种都认；
   字段差异交给 normalizeGalleryRecord 归一。 */
export function documentRecords(value) {
  if (value?.results && typeof value.results === 'object' && !Array.isArray(value.results)) {
    return Object.values(value.results);
  }
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value)) return value;
  return [];
}

function normalizeDocument(value) {
  const document = emptyDocument();
  const source = documentRecords(value);
  for (const item of source) {
    if (!item?.resultId || item.status !== 'available') continue;
    document.results[item.resultId] = normalizeGalleryRecord(item);
  }
  document.updatedAt = String(value?.updatedAt || document.updatedAt);
  return document;
}

/* 改动先落在内存里，文件延后合并写：flushDelayMs 内的几次改动只写一次盘，写的时候直接序列化内存里的
   文档，不再整份深拷贝。写失败内存照旧是最新的，下一次写一起带上；要等写完就 flush()。
   noteChange(resultId)、attach(document)、expedite() 是给分片存储用的：哪条记录变了、内存里那份活的文档
   是哪个、接下来的写入要当场发出去（页面要转入后台了）。 */
export function createGalleryMetadataStore({ readDocument, writeDocument, flushDelayMs = 0, noteChange, attach, expedite }) {
  let document = null;
  let initializePromise = null;
  let writeChain = Promise.resolve();
  let pending = null;
  const mark = typeof noteChange === 'function' ? noteChange : () => {};

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

  function touch(options) {
    document.updatedAt = new Date().toISOString();
    const write = scheduleFlush(options);
    write.catch(error => console.warn('[画笺] 写入画廊元数据失败，下次写入时再试', error));
    return write;
  }

  async function initialize({ legacyItems = [] } = {}) {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      const raw = await readDocument();
      document = normalizeDocument(raw);
      attach?.(document);
      /* 读到的是别的格式（fork 1.6.2 的 items 数组）就立刻按本格式改写一遍，
         免得文件一直停在旧格式上。 */
      const foreignFormat = documentRecords(raw).length > 0
        && !(raw?.results && typeof raw.results === 'object' && !Array.isArray(raw.results));
      for (const item of legacyItems || []) {
        if (!item?.resultId || item.status !== 'available') continue;
        if (!document.results[item.resultId]) {
          document.results[item.resultId] = normalizeGalleryRecord(item);
          mark(item.resultId);
        }
      }
      if (foreignFormat || (legacyItems || []).length) {
        await touch({ immediate: true });
      }
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

  function ready() {
    if (!document) throw new Error('Gallery metadata store is not initialized');
  }

  const api = {
    initialize,
    values() {
      ready();
      return Object.values(document.results).map(clone);
    },
    /* 只读的原件（不拷贝）：自动清理这种只看不改的用它，几千条记录不用每次都深拷贝一遍。 */
    records() {
      ready();
      return Object.values(document.results);
    },
    get(resultId) {
      ready();
      const value = document.results[resultId];
      return value ? clone(value) : null;
    },
    has(resultId) {
      ready();
      return Boolean(document.results[resultId]);
    },
    async putMany(items) {
      ready();
      let changed = false;
      for (const item of items || []) {
        if (!item?.resultId || item.status !== 'available') continue;
        document.results[item.resultId] = normalizeGalleryRecord(item);
        mark(item.resultId);
        changed = true;
      }
      if (changed) touch();
      return (items || []).map(item => api.get(item.resultId)).filter(Boolean);
    },
    async update(resultId, patch) {
      ready();
      const current = document.results[resultId];
      if (!current) return null;
      document.results[resultId] = normalizeGalleryRecord({ ...current, ...patch, resultId });
      mark(resultId);
      touch();
      return api.get(resultId);
    },
    async removeMany(resultIds) {
      ready();
      const existingIds = (resultIds || []).filter(resultId => document.results[resultId]);
      if (!existingIds.length) return;
      for (const resultId of existingIds) {
        delete document.results[resultId];
        mark(resultId);
      }
      touch();
    },
    remove(resultId) {
      return api.removeMany([resultId]);
    },
    /* 等写完；还在等合并写的立刻写（页面转入后台前、整理聊天前都用它）。 */
    flush() {
      expedite?.();
      return pending ? scheduleFlush({ immediate: true }) : writeChain;
    },
  };
  return api;
}

/* 酒馆用户文件里的画廊索引。options：
   - flushDelayMs：合并写的间隔；
   - cache：分片的本机缓存（默认浏览器的 IndexedDB；传 null 不用缓存）；
   - segmentBytes / segmentRecords：一个分片的上限（测试里调小）。
   返回的存储多一个 storage：status() 给设置页显示现在是拆开的还是整份的，whenIdle() 等后台的活做完。 */
export function createSillyTavernGalleryMetadataStore(compat, fetchImpl = globalThis.fetch, options = {}) {
  const {
    cache = sharedSegmentCache(),
    segmentBytes = GALLERY_SEGMENT_BYTES,
    segmentRecords = GALLERY_SEGMENT_RECORDS,
    backend: backendOptions = {},
    ...storeOptions
  } = options;
  const backend = createSegmentedBackend({
    files: createTavernFiles(compat, fetchImpl, { cache, label: '画廊元数据' }),
    label: '画廊元数据',
    manifestFile: GALLERY_INDEX_FILE,
    segmentPrefix: GALLERY_SEGMENT_PREFIX,
    legacyFile: GALLERY_METADATA_FILE,
    recordsKey: 'results',
    legacyRecords: documentRecords,
    idOf: record => record?.resultId,
    orderOf: record => record?.createdAt,
    maxSegmentBytes: segmentBytes,
    maxSegmentRecords: segmentRecords,
    /* 手机网络抖一下就整个初始化失败太亏：读分片失败先重试两次。 */
    retryDelaysMs: [300, 1200],
    /* 画廊记录丢了图就从画廊里消失：写分片之前先看一眼别的设备有没有往里加过，加过的原样带上。 */
    passThroughForeign: true,
    ...backendOptions,
  });
  const store = createGalleryMetadataStore({
    flushDelayMs: GALLERY_FLUSH_DELAY_MS,
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

export function createMemoryGalleryMetadataStore(initialDocument = null, options = {}) {
  let document = initialDocument ? clone(initialDocument) : emptyDocument();
  let writes = 0;
  const store = createGalleryMetadataStore({
    flushDelayMs: 0,
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
