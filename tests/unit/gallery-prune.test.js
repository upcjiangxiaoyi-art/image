import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MetadataStore } = require('../../server-plugin/src/services/metadata');

async function makeStore(keepMax) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-prune-'));
  const store = await new MetadataStore(root).initialize();
  const removed = [];
  store.storage = { async remove(relativePath) { removed.push(relativePath); } };
  if (keepMax !== undefined) store.galleryKeepMax = keepMax;
  return { store, removed, root };
}

function record(n) {
  return {
    resultId: `r${String(n).padStart(4, '0')}`,
    status: 'available',
    localRelativePath: `images/r${n}.png`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
  };
}

test('默认保留 100 张，超出的按时间从旧到新裁掉', async () => {
  const { store, removed } = await makeStore();
  for (let n = 1; n <= 130; n += 1) await store.putResult(record(n));

  const kept = Object.values(store.index.results);
  assert.equal(kept.length, 100, '索引里应只剩 100 条');
  assert.equal(removed.length, 30, '应删掉 30 个文件');
  assert.ok(kept.every(r => Number(r.resultId.slice(1)) > 30), '留下的必须是最新的 100 张');
  assert.ok(removed.includes('images/r1.png'), '最旧那张要被删');
  assert.ok(!removed.includes('images/r130.png'), '最新那张不能被删');
});

test('删掉的图不能在 tag / attempt 里留下死引用', async () => {
  const { store } = await makeStore(2);
  await store.transaction(index => {
    index.tags.t1 = { tagId: 't1', resultIds: ['r0001', 'r0002', 'r0003'], latestResultId: 'r0001' };
    index.attempts.a1 = { attemptId: 'a1', resultIds: ['r0001', 'r0003'] };
  });
  for (let n = 1; n <= 3; n += 1) await store.putResult(record(n));

  const tag = store.index.tags.t1;
  assert.ok(!tag.resultIds.includes('r0001'), 'tag 不该再引用被删的图');
  assert.notEqual(tag.latestResultId, 'r0001', 'latestResultId 不该指向被删的图');
  assert.ok(!store.index.attempts.a1.resultIds.includes('r0001'), 'attempt 也要清干净');
});

test('设成 0 表示不限制', async () => {
  const { store, removed } = await makeStore(0);
  for (let n = 1; n <= 40; n += 1) await store.putResult(record(n));
  assert.equal(Object.values(store.index.results).length, 40);
  assert.equal(removed.length, 0, '不限制时一张都不该删');
});

test('删文件失败也要把索引清掉，不留指向空文件的死记录', async () => {
  const { store } = await makeStore(1);
  store.storage = { async remove() { throw new Error('EACCES'); } };
  for (let n = 1; n <= 3; n += 1) await store.putResult(record(n));
  assert.equal(Object.values(store.index.results).length, 1, '文件删不掉也要裁索引');
});
