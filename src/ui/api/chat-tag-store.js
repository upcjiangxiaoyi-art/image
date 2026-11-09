/* 每个聊天一份侧文件：生图标签的状态按 tagId 记——提示词指纹、当前显示哪张、图片引用、自动生图的标记。
   聊天的每一楼只留 { messageUuid, tagIds } 这样的引用（见 tag-identity.js），提示词在正文里本来就有，
   生成记录在 attempt-store，图片元数据在画廊文件；这里只放那几样别处没有的小东西。

   为什么按聊天分：酒馆每次保存都是整个聊天原样上传，生图数据跟着聊天一起膨胀、一起重传；放到侧文件后
   出图、删图、清理都只写这一个小文件，聊天只在出现新标签时才动一次。文件走酒馆的 /api/files/upload，
   和画廊元数据同一套接口，多设备共用、跟着酒馆走。

   写入幂等：内容和上次写进文件的一样就不写；文档里不放时间戳、随机数这类每次都不一样的东西，
   序列化时 tagId 排好序，页面重开、切回聊天都不会多写一次。 */
import { DirectError, bytesToBase64 } from './openai-direct.js';

export const CHAT_TAG_FILE_PREFIX = 'st-image-atelier-chat-';
export const CHAT_TAG_FLUSH_DELAY_MS = 1500;
const DOCUMENT_SCHEMA_VERSION = 1;
export const RECORD_KEY_ORDER = Object.freeze(['promptHash', 'latestResultId', 'resultRefs', 'autoAttempted', 'autoSuppressed']);

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/* cyrb53：又快又短的字符串指纹，用来认「这个 <draw> 还是不是原来那个」。只在同一楼的几个标签之间比，
   53 位足够。返回 36 进制，十来个字符。 */
export function promptHash(text) {
  const source = String(text ?? '');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* 侧文件名：聊天名（截短、只留字母数字和 _ -）+ 角色和聊天名一起算的指纹。
   酒馆的 /api/files/upload 只收 [A-Za-z0-9_.-] 的文件名（中文、空格、@ 都会被 400 拒掉），也不认子目录，
   所以中文聊天名只剩时间戳那段，靠指纹区分；同名聊天（不同角色）也不会撞车。 */
export function chatTagFileName({ chatId = '', characterKey = '' } = {}) {
  const id = String(chatId || '');
  if (!id) return '';
  const slug = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 40) || 'chat';
  return `${CHAT_TAG_FILE_PREFIX}${slug}-${promptHash(`${characterKey}|${id}`)}.json`;
}

/* 记录只放这几样、固定顺序：序列化比对才稳。 */
export function normalizeTagRecord(value = {}) {
  const refs = Array.isArray(value.resultRefs) ? value.resultRefs : [];
  return {
    promptHash: String(value.promptHash || ''),
    latestResultId: typeof value.latestResultId === 'string' && value.latestResultId ? value.latestResultId : null,
    resultRefs: refs
      .filter(ref => ref && typeof ref.resultId === 'string' && ref.resultId)
      .map(ref => ({
        resultId: ref.resultId,
        path: String(ref.path || ''),
        createdAt: String(ref.createdAt || ''),
      })),
    autoAttempted: value.autoAttempted === true,
    autoSuppressed: value.autoSuppressed === true,
  };
}

function emptyDocument({ chatId = '', characterKey = '' } = {}) {
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, chatId: String(chatId || ''), characterKey: String(characterKey || ''), tags: {} };
}

function normalizeDocument(value, identity) {
  const document = emptyDocument(identity);
  const source = value?.tags && typeof value.tags === 'object' && !Array.isArray(value.tags) ? value.tags : {};
  for (const [tagId, record] of Object.entries(source)) {
    if (!tagId || !record || typeof record !== 'object') continue;
    document.tags[tagId] = normalizeTagRecord(record);
  }
  return document;
}

/* 序列化：tagId 排序，内容一样字符串就一样。 */
export function serializeDocument(document) {
  const tags = {};
  for (const tagId of Object.keys(document.tags).sort()) tags[tagId] = document.tags[tagId];
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    chatId: document.chatId,
    characterKey: document.characterKey,
    tags,
  });
}

export function createChatTagStore({ readDocument, writeDocument, flushDelayMs = 0, chatId = '', characterKey = '' }) {
  const identity = { chatId, characterKey };
  let document = null;
  let initializePromise = null;
  let lastWritten = '';
  let writeChain = Promise.resolve();
  let pending = null;

  function fire(entry) {
    if (pending === entry) pending = null;
    const write = writeChain.then(async () => {
      const serialized = serializeDocument(document);
      /* 内容没变不写；空文档也不为了「建个文件」写一次。 */
      if (serialized === lastWritten || (!lastWritten && !Object.keys(document.tags).length)) return false;
      await writeDocument(serialized);
      lastWritten = serialized;
      return true;
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
    entry.timer = setTimeout(() => fire(entry), immediate ? 0 : flushDelayMs);
    entry.timer.unref?.();
    return entry.promise;
  }

  function touch(options) {
    const write = scheduleFlush(options);
    write.catch(error => console.warn('[画笺] 写入聊天的生图标签侧文件失败，下次写入时再试', error));
    return write;
  }

  function ready() {
    if (!document) throw new Error('Chat tag store is not initialized');
  }

  async function initialize() {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      const raw = await readDocument();
      document = normalizeDocument(raw, identity);
      /* 读到什么就当作「上次写的」：原样再写一遍没有意义。文件不存在（null）时留空，第一次有内容才写。 */
      lastWritten = raw == null ? '' : serializeDocument(document);
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

  const api = {
    initialize,
    get chatId() { return identity.chatId; },
    get characterKey() { return identity.characterKey; },
    get(tagId) {
      ready();
      const record = document.tags[tagId];
      return record ? clone(record) : null;
    },
    has(tagId) {
      ready();
      return Boolean(document.tags[tagId]);
    },
    /* 只读原件（不拷贝）：扫全部记录用。 */
    records() {
      ready();
      return document.tags;
    },
    size() {
      ready();
      return Object.keys(document.tags).length;
    },
    /* 放一条：和现有的一样就什么都不做。返回有没有变。 */
    put(tagId, record, options) {
      ready();
      if (!tagId) return false;
      const next = normalizeTagRecord(record);
      const current = document.tags[tagId];
      if (current && JSON.stringify(current) === JSON.stringify(next)) return false;
      document.tags[tagId] = next;
      touch(options);
      return true;
    },
    putMany(entries, options) {
      ready();
      let changed = false;
      for (const [tagId, record] of entries || []) {
        if (!tagId) continue;
        const next = normalizeTagRecord(record);
        const current = document.tags[tagId];
        if (current && JSON.stringify(current) === JSON.stringify(next)) continue;
        document.tags[tagId] = next;
        changed = true;
      }
      if (changed) touch(options);
      return changed;
    },
    /* 改几个字段：没有这条就按默认值建。返回改后的记录（拷贝）。 */
    update(tagId, patch, options) {
      ready();
      const current = document.tags[tagId] || normalizeTagRecord({});
      api.put(tagId, { ...current, ...patch }, options);
      return clone(document.tags[tagId]);
    },
    remove(tagId, options) {
      ready();
      if (!document.tags[tagId]) return false;
      delete document.tags[tagId];
      touch(options);
      return true;
    },
    removeMany(tagIds, options) {
      ready();
      let changed = false;
      for (const tagId of tagIds || []) {
        if (!document.tags[tagId]) continue;
        delete document.tags[tagId];
        changed = true;
      }
      if (changed) touch(options);
      return changed;
    },
    flush() {
      return pending ? scheduleFlush({ immediate: true }) : writeChain;
    },
  };
  return api;
}

export function createSillyTavernChatTagStore(compat, identity, fetchImpl = globalThis.fetch, options = {}) {
  const name = chatTagFileName(identity);
  return createChatTagStore({
    flushDelayMs: CHAT_TAG_FLUSH_DELAY_MS,
    ...identity,
    ...options,
    async readDocument() {
      if (!name) return null;
      const response = await fetchImpl(`/user/files/${encodeURIComponent(name)}?t=${Date.now()}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new DirectError('LOCAL_SAVE_FAILED', `读取聊天的生图标签侧文件失败（HTTP ${response.status}）`, response.status);
      }
      try {
        return await response.json();
      } catch {
        throw new DirectError('LOCAL_SAVE_FAILED', '聊天的生图标签侧文件不是有效 JSON');
      }
    },
    async writeDocument(serialized) {
      if (!name) return;
      const bytes = new TextEncoder().encode(serialized);
      const response = await fetchImpl('/api/files/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: compat.headers(),
        body: JSON.stringify({ name, data: bytesToBase64(bytes) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new DirectError(
          'LOCAL_SAVE_FAILED',
          payload?.error || `写入聊天的生图标签侧文件失败（HTTP ${response.status}）`,
          response.status,
        );
      }
    },
  });
}

/* 测试用：内存里的一份，记下写了几次、写了什么。 */
export function createMemoryChatTagStore(initialDocument = null, options = {}) {
  let stored = initialDocument ? JSON.stringify(initialDocument) : null;
  let writes = 0;
  const store = createChatTagStore({
    flushDelayMs: 0,
    ...options,
    readDocument: async () => (stored == null ? null : JSON.parse(stored)),
    writeDocument: async serialized => {
      writes += 1;
      stored = serialized;
    },
  });
  Object.defineProperty(store, 'document', { get: () => (stored == null ? null : JSON.parse(stored)) });
  Object.defineProperty(store, 'writes', { get: () => writes });
  return store;
}
