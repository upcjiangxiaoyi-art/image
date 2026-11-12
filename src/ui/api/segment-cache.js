/* 分片文件的本机缓存：文件名 → { etag, text }，放在浏览器的 IndexedDB 里。
   只是缓存，服务器上的文件才算数：每次打开页面都拿着 ETag 去问服务器，没变（304）才用这里的正文。
   被浏览器清掉、隐私模式用不了、读写出错——都只是这一次多下载一遍，不影响对错。
   iOS Safari 的 IndexedDB 偶尔会卡住不回调，所以每个操作都有超时：超时一次，这次页面里就不再用缓存。 */
const DB_NAME = 'stImageAtelier.files';
const STORE_NAME = 'segments';
const TIMEOUT_MS = 2500;

export function createIndexedDbSegmentCache({ indexedDB = globalThis.indexedDB, timeoutMs = TIMEOUT_MS } = {}) {
  let disabled = !indexedDB;
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB 打不开'));
        request.onblocked = () => reject(new Error('IndexedDB 被占着'));
      });
    }
    return opening;
  }

  /* 做一次读或写；出错、超时都返回 null，不抛。 */
  function run(mode, work) {
    if (disabled) return Promise.resolve(null);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        disabled = true;
        resolve(null);
      }, timeoutMs);
      const finish = value => {
        clearTimeout(timer);
        resolve(value);
      };
      let operation;
      try {
        operation = open().then(database => new Promise((done, fail) => {
          const transaction = database.transaction(STORE_NAME, mode);
          const request = work(transaction.objectStore(STORE_NAME));
          transaction.oncomplete = () => done(request?.result ?? null);
          transaction.onerror = () => fail(transaction.error);
          transaction.onabort = () => fail(transaction.error);
        }));
      } catch (error) {
        operation = Promise.reject(error);
      }
      operation.then(finish, () => {
        disabled = true;
        finish(null);
      });
    });
  }

  return {
    async get(name) {
      const value = await run('readonly', store => store.get(name));
      return value && typeof value.text === 'string' && value.etag ? { etag: String(value.etag), text: value.text } : null;
    },
    async set(name, { etag, text }) {
      await run('readwrite', store => store.put({ etag, text }, name));
    },
    async delete(name) {
      await run('readwrite', store => store.delete(name));
    },
    /* prefix 开头、不在 keep（Set）里的都删掉。 */
    async prune(prefix, keep) {
      const keys = await run('readonly', store => store.getAllKeys());
      const stale = (keys || []).filter(key => typeof key === 'string' && key.startsWith(prefix) && !keep.has(key));
      if (!stale.length) return 0;
      await run('readwrite', store => {
        for (const key of stale) store.delete(key);
        return null;
      });
      return stale.length;
    },
  };
}

/* 测试用，也是「没有 IndexedDB」时的样子。 */
export function createMemorySegmentCache(initial = []) {
  const entries = new Map(initial);
  return {
    entries,
    async get(name) {
      const value = entries.get(name);
      return value ? { ...value } : null;
    },
    async set(name, { etag, text }) {
      entries.set(name, { etag, text });
    },
    async delete(name) {
      entries.delete(name);
    },
    async prune(prefix, keep) {
      let removed = 0;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix) && !keep.has(key)) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

let shared = null;

/* 画廊索引和生成记录共用一个缓存（一个数据库）。 */
export function sharedSegmentCache() {
  if (!shared) shared = createIndexedDbSegmentCache();
  return shared;
}
