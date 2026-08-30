/* 客户端画廊上限 —— Claude Opus 5
   云酒馆走 direct 模式、没有 server-plugin，服务端那条裁剪跑不到。
   namespace.gallery 只进不出，酒馆设置越存越大、读画廊越来越卡。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';

function makeClient({ count, keepMax, chat = [] } = {}) {
  const deleted = [];
  const gallery = Array.from({ length: count }, (unused, index) => ({
    resultId: `r${String(index + 1).padStart(4, '0')}`,
    status: 'available',
    localRelativePath: `user/images/r${index + 1}.png`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  }));
  const extensionSettings = { stImageAtelier: { gallery, galleryKeepMax: keepMax } };

  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/api/images/delete')) {
      deleted.push(JSON.parse(options.body).path);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const client = createDirectApiClient({
    compat: { chat: () => chat, currentChatId: () => 'c1', headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    keyStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  return { client, namespace: extensionSettings.stImageAtelier, deleted };
}

test('超过 100 张时裁到 100，删的是最旧的', async () => {
  const { client, namespace, deleted } = makeClient({ count: 130 });
  const removed = await client.pruneGallery();
  assert.equal(removed, 30, '应裁掉 30 张');
  assert.equal(namespace.gallery.length, 100, '画廊只剩 100 张');
  assert.ok(namespace.gallery.every(item => Number(item.resultId.slice(1)) > 30), '留下的是最新的');
  assert.equal(deleted.length, 30, '图片文件也要删掉，不能只清列表');
  assert.ok(deleted.includes('user/images/r1.png'), '最旧那张要被删');
});

test('没超上限时一张都不动', async () => {
  const { client, namespace, deleted } = makeClient({ count: 40 });
  assert.equal(await client.pruneGallery(), 0);
  assert.equal(namespace.gallery.length, 40);
  assert.equal(deleted.length, 0);
});

test('galleryKeepMax 设 0 表示不限制', async () => {
  const { client, namespace } = makeClient({ count: 300, keepMax: 0 });
  assert.equal(await client.pruneGallery(), 0);
  assert.equal(namespace.gallery.length, 300);
});

test('被删的图不能在楼里留下死引用', async () => {
  const chat = [{
    extra: { stImageAtelier: { tags: [{
      tagId: 't1',
      results: [{ resultId: 'r0001' }, { resultId: 'r0003' }],
      resultIds: ['r0001', 'r0003'],
      latestResultId: 'r0001',
    }] } },
  }];
  const { client, namespace } = makeClient({ count: 3, keepMax: 1, chat });
  await client.pruneGallery();
  const tag = chat[0].extra.stImageAtelier.tags[0];
  assert.equal(namespace.gallery.length, 1, '画廊应只剩最新一张');
  assert.ok(!tag.resultIds.includes('r0001'), 'resultIds 要清掉被删的');
  assert.ok(!tag.results.some(item => item.resultId === 'r0001'), 'results 也要清掉');
  assert.notEqual(tag.latestResultId, 'r0001', 'latestResultId 不该指向被删的图');
});

test('删图接口失败也要把画廊清干净，不留指向空文件的记录', async () => {
  const { client, namespace } = makeClient({ count: 5, keepMax: 2 });
  globalThis.fetch = async () => { throw new Error('网络断了'); };
  await client.pruneGallery();
  assert.equal(namespace.gallery.length, 2, '文件删不掉也要裁画廊');
});
