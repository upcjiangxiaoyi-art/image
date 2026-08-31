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
  const extensionSettings = { stImageAtelier: { gallery, settings: {} } };
  if (keepMax !== undefined) extensionSettings.stImageAtelier.settings.galleryKeepMax = keepMax;

  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/api/images/delete')) {
      deleted.push(JSON.parse(options.body).path);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const saves = [];
  const client = createDirectApiClient({
    compat: { chat: () => chat, currentChatId: () => 'c1', headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => { saves.push(1); },
    keyStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  return { client, namespace: extensionSettings.stImageAtelier, deleted, saves };
}

test('超过 100 张时裁到 100，删的是最旧的', async () => {
  const { client, namespace, deleted } = makeClient({ count: 130 });
  // 启动时会自动裁一次，所以别断返回值（可能已经裁完了）——断最终状态
  await client.pruneGallery();
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

test('裁剪必须落盘，否则刷新后列表回来了而文件已删，全成破图', async () => {
  const { client, saves } = makeClient({ count: 120, keepMax: 100 });
  saves.length = 0;
  await client.pruneGallery();
  assert.ok(saves.length > 0, '裁完必须调用 saveSettingsDebounced 把结果存下来');
});

test('文件已不存在的破记录要从画廊摘掉', async () => {
  const { client, namespace } = makeClient({ count: 120, keepMax: 100 });
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'HEAD') return new Response('', { status: 404 });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const dropped = await client.dropBrokenEntries();
  assert.equal(dropped, 20, '超出上限那 20 条探到 404，应被摘掉');
  assert.equal(namespace.gallery.length, 100, '画廊只剩能打开的 100 张');
});

test('文件还在的记录一条都不动', async () => {
  const { client, namespace } = makeClient({ count: 120, keepMax: 100 });
  globalThis.fetch = async () => new Response('', { status: 200 });
  assert.equal(await client.dropBrokenEntries(), 0, '文件都在就不该摘任何记录');
  assert.equal(namespace.gallery.length, 120);
});

/* ---- 彻底抛弃：上游也要抹掉，否则刷新就长回来 ---- */

function makeWithChat({ count, keepMax = 2 } = {}) {
  const saved = { chat: 0, prefs: 0 };
  const results = Array.from({ length: count }, (unused, index) => ({
    resultId: `r${String(index + 1).padStart(4, '0')}`,
    status: 'available',
    localRelativePath: `user/images/r${index + 1}.png`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  }));
  const chat = [{
    extra: { stImageAtelier: { tags: [{
      tagId: 't1',
      results: results.map(item => ({ ...item })),
      resultIds: results.map(item => item.resultId),
      latestResultId: results.at(-1).resultId,
    }] } },
  }];
  const extensionSettings = {
    stImageAtelier: { gallery: results.map(item => ({ ...item })), settings: { galleryKeepMax: keepMax } },
  };
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const client = createDirectApiClient({
    compat: {
      chat: () => chat,
      currentChatId: () => 'c1',
      headers: () => ({}),
      save: async () => { saved.chat += 1; },
    },
    extensionSettings,
    saveSettingsDebounced: () => { saved.prefs += 1; },
    keyStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  return { client, chat, namespace: extensionSettings.stImageAtelier, saved };
}

test('裁剪要连聊天记录里的 results 一起抹掉（不留墓碑）', async () => {
  const { client, chat } = makeWithChat({ count: 5, keepMax: 2 });
  await client.pruneGallery();
  const tag = chat[0].extra.stImageAtelier.tags[0];
  assert.equal(tag.results.length, 2, '楼里的 results 也要裁到 2 条');
  assert.equal(tag.resultIds.length, 2, 'resultIds 同步');
  assert.ok(!tag.results.some(item => item.resultId === 'r0001'), '最旧那条要消失');
});

test('上游改动必须写回聊天存档，否则刷新后原样读回来', async () => {
  const { client, saved } = makeWithChat({ count: 5, keepMax: 2 });
  saved.chat = 0;
  await client.pruneGallery();
  assert.ok(saved.chat > 0, '改了 tag.results 就必须调 compat.save()');
});

test('抹干净之后，重新解析该层不会把图塞回画廊', async () => {
  const { client, namespace } = makeWithChat({ count: 5, keepMax: 2 });
  await client.pruneGallery();
  assert.equal(namespace.gallery.length, 2);
  await client.resolveTags(['t1']);          // 模拟刷新后重新渲染这一层
  assert.equal(namespace.gallery.length, 2, '被抛弃的图不该复活');
});

test('手动清理可以临时收得更狠，并把新上限存下来', async () => {
  const { client, namespace } = makeWithChat({ count: 10, keepMax: 100 });
  const report = await client.cleanupGallery(3);
  assert.equal(report.after, 3, '应清到 3 张');
  assert.equal(report.removed, 7);
  assert.equal(namespace.settings.galleryKeepMax, 3, '新上限要落进设置');
});

test('上限设 0 时手动清理也不删东西', async () => {
  const { client, namespace } = makeWithChat({ count: 10, keepMax: 100 });
  await client.cleanupGallery(0);
  assert.equal(namespace.gallery.length, 10, '0 表示不限制');
});

test('compat.save 缺失时裁剪仍要跑完，不能半途炸掉', async () => {
  const { client, namespace } = makeClient({ count: 5, keepMax: 2 });
  await client.pruneGallery();
  assert.equal(namespace.gallery.length, 2, '存档写不了也要把画廊裁完');
});
