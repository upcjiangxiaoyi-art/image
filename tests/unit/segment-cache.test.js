/* 2.4.0 分片的本机缓存（IndexedDB）：只是缓存，用不了、卡住、出错都当成没有，不能拖住页面。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedDbSegmentCache, createMemorySegmentCache } from '../../src/ui/api/segment-cache.js';

/* 够用的假 IndexedDB：一个库、一个表，请求和事务的回调都是异步来的。 */
function fakeIndexedDb({ hangOpen = false, failOpen = false, failWrites = false } = {}) {
  const databases = new Map();
  const later = callback => setTimeout(callback, 0);
  const stats = { opens: 0, transactions: 0 };
  return {
    stats,
    databases,
    open(name) {
      stats.opens += 1;
      const request = {};
      if (hangOpen) return request;
      later(() => {
        if (failOpen) {
          request.error = new Error('denied');
          request.onerror?.();
          return;
        }
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const tables = databases.get(name);
        request.result = {
          objectStoreNames: { contains: table => tables.has(table) },
          createObjectStore: table => tables.set(table, new Map()),
          transaction(table, mode) {
            stats.transactions += 1;
            const rows = tables.get(table);
            const transaction = { error: null };
            const run = work => {
              const operation = {};
              later(() => {
                if (failWrites && mode === 'readwrite') {
                  transaction.error = new Error('quota');
                  transaction.onabort?.();
                  return;
                }
                operation.result = work();
              });
              return operation;
            };
            later(() => later(() => { if (!transaction.error) transaction.oncomplete?.(); }));
            return {
              ...transaction,
              set oncomplete(handler) { transaction.oncomplete = handler; },
              set onerror(handler) { transaction.onerror = handler; },
              set onabort(handler) { transaction.onabort = handler; },
              get error() { return transaction.error; },
              objectStore: () => ({
                get: key => run(() => rows.get(key)),
                put: (value, key) => run(() => { rows.set(key, value); return key; }),
                delete: key => run(() => { rows.delete(key); }),
                getAllKeys: () => run(() => [...rows.keys()]),
              }),
            };
          },
        };
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test('存、取、删、按前缀清：下一次打开页面（新的缓存对象）还读得到', async () => {
  const indexedDB = fakeIndexedDb();
  const cache = createIndexedDbSegmentCache({ indexedDB });
  assert.equal(await cache.get('gallery-m0001.json'), null);
  await cache.set('gallery-m0001.json', { etag: 'W/"10-1"', text: '{"a":1}' });
  await cache.set('gallery-m0002.json', { etag: 'W/"10-2"', text: '{"b":2}' });
  await cache.set('attempts-m0001.json', { etag: 'W/"10-3"', text: '{"c":3}' });
  assert.deepEqual(await cache.get('gallery-m0001.json'), { etag: 'W/"10-1"', text: '{"a":1}' });

  const reopened = createIndexedDbSegmentCache({ indexedDB });
  assert.deepEqual(await reopened.get('gallery-m0002.json'), { etag: 'W/"10-2"', text: '{"b":2}' });
  assert.equal(await reopened.prune('gallery-', new Set(['gallery-m0002.json'])), 1);
  assert.equal(await reopened.get('gallery-m0001.json'), null);
  assert.ok(await reopened.get('attempts-m0001.json'), '别的前缀不动');
  await reopened.delete('attempts-m0001.json');
  assert.equal(await reopened.get('attempts-m0001.json'), null);
  assert.equal(await reopened.prune('gallery-', new Set(['gallery-m0002.json'])), 0);
  assert.equal(indexedDB.stats.opens, 2, '一个缓存对象只开一次库');
});

test('没有 IndexedDB、打不开、写失败：都当成没有缓存，不抛错', async () => {
  const none = createIndexedDbSegmentCache({ indexedDB: undefined });
  assert.equal(await none.get('a'), null);
  await none.set('a', { etag: 'e', text: 't' });
  await none.delete('a');
  assert.equal(await none.prune('a', new Set()), 0);

  const denied = createIndexedDbSegmentCache({ indexedDB: fakeIndexedDb({ failOpen: true }) });
  assert.equal(await denied.get('a'), null);
  await denied.set('a', { etag: 'e', text: 't' });
  assert.equal(await denied.get('a'), null);

  const full = fakeIndexedDb({ failWrites: true });
  const quota = createIndexedDbSegmentCache({ indexedDB: full });
  await quota.set('a', { etag: 'e', text: 't' });
  assert.equal(await quota.get('a'), null, '写失败过一次，这次页面里就不再用缓存');
  const before = full.stats.transactions;
  await quota.get('b');
  assert.equal(full.stats.transactions, before, '也不再去碰数据库');
});

test('IndexedDB 卡住不回调（iOS Safari 偶尔会）：等到超时就当没有，之后不再等', async () => {
  const indexedDB = fakeIndexedDb({ hangOpen: true });
  const cache = createIndexedDbSegmentCache({ indexedDB, timeoutMs: 30 });
  const started = Date.now();
  assert.equal(await cache.get('a'), null);
  const waited = Date.now() - started;
  assert.ok(waited >= 25 && waited < 1000, `等了 ${waited} 毫秒`);
  const again = Date.now();
  assert.equal(await cache.get('b'), null);
  await cache.set('b', { etag: 'e', text: 't' });
  assert.ok(Date.now() - again < 20, '第二次起立刻返回，不再等超时');
});

test('存进去的不是 { etag, text } 的样子就当没有', async () => {
  const indexedDB = fakeIndexedDb();
  const cache = createIndexedDbSegmentCache({ indexedDB });
  await cache.set('ok', { etag: 'e', text: '' });
  assert.deepEqual(await cache.get('ok'), { etag: 'e', text: '' }, '空正文也是正文');
  indexedDB.databases.get('stImageAtelier.files').get('segments').set('bad', { etag: '', text: 'x' });
  indexedDB.databases.get('stImageAtelier.files').get('segments').set('worse', 'just a string');
  assert.equal(await cache.get('bad'), null);
  assert.equal(await cache.get('worse'), null);
});

test('内存版（测试用）行为一样', async () => {
  const cache = createMemorySegmentCache();
  await cache.set('p-1', { etag: 'e', text: 't' });
  await cache.set('q-1', { etag: 'e', text: 't' });
  const value = await cache.get('p-1');
  value.text = 'changed';
  assert.equal((await cache.get('p-1')).text, 't', '拿到的是拷贝');
  assert.equal(await cache.prune('p-', new Set()), 1);
  assert.equal(await cache.get('p-1'), null);
  await cache.delete('q-1');
  assert.equal(cache.entries.size, 0);
});
