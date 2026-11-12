import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_INDEX_FILE,
  GALLERY_METADATA_FILE,
  GALLERY_SEGMENT_PREFIX,
  createMemoryGalleryMetadataStore,
  createSillyTavernGalleryMetadataStore,
} from '../../src/ui/api/gallery-metadata-store.js';
import { createFileServer } from '../helpers/file-server.js';

test('直连画廊通过 SillyTavern 用户文件接口读写：全新安装时聊天里带着的旧图记录写进分片，字段归一', async () => {
  const server = createFileServer();
  const store = createSillyTavernGalleryMetadataStore({
    headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
  }, server.fetch, { cache: null, backend: { warn: () => {} } });

  await store.initialize({
    legacyItems: [{
      resultId: 'legacy',
      status: 'available',
      prompt: 'old',
      promptSnapshot: 'actual',
      resolvedPrompt: 'resolved',
    }],
  });
  await store.storage.whenIdle();
  const manifest = server.json(GALLERY_INDEX_FILE);
  const written = Object.assign({}, ...manifest.segments
    .filter(id => server.files.has(`${GALLERY_SEGMENT_PREFIX}${id}.json`))
    .map(id => server.json(`${GALLERY_SEGMENT_PREFIX}${id}.json`).results));
  assert.equal(written.legacy.prompt, 'actual');
  assert.equal('promptSnapshot' in written.legacy, false);
  assert.equal('resolvedPrompt' in written.legacy, false);
  assert.ok(server.uploads.every(upload => /^[A-Za-z0-9_.-]+$/.test(upload.name)), '文件名都是酒馆收的');
});

/* 合流兼容（1.6.5）：本仓库 1.6.2 写出的索引文件是 { version, items: [...] }，
   字段是 promptSnapshot / negativePromptSnapshot。同名文件，读不出来就会被空文档覆盖。 */
test('读入 fork 1.6.2 格式的索引文件：items 数组与 promptSnapshot 字段全部归一，不丢记录', async () => {
  const forkDocument = {
    version: 1,
    updatedAt: '2026-09-13T00:00:00.000Z',
    items: [
      { resultId: 'a', status: 'available', promptSnapshot: 'cat', negativePromptSnapshot: 'lowres', favorite: true, localRelativePath: 'user/images/st-image-atelier/a.png' },
      { resultId: 'b', status: 'available', promptSnapshot: 'dog', artistPresetId: 'artist-1', localRelativePath: 'user/images/st-image-atelier/b.png' },
      { resultId: 'gone', status: 'deleted', promptSnapshot: 'x' },
    ],
  };
  const server = createFileServer();
  server.put(GALLERY_METADATA_FILE, forkDocument);
  const store = createSillyTavernGalleryMetadataStore({ headers: () => ({}) }, server.fetch, { cache: null, backend: { warn: () => {} } });
  await store.initialize();
  const values = store.values();
  assert.deepEqual(values.map(item => item.resultId).sort(), ['a', 'b'], 'deleted 的丢掉，可用的一条不少');
  const a = store.get('a');
  assert.equal(a.prompt, 'cat');
  assert.equal(a.negativePrompt, 'lowres');
  assert.equal(a.favorite, true);
  assert.equal('promptSnapshot' in a, false);
  assert.equal(store.get('b').provider, 'novelai');

  await store.storage.whenIdle();
  assert.equal(store.storage.status().mode, 'segmented', '拆成分片了');
  const written = Object.assign({}, ...server.json(GALLERY_INDEX_FILE).segments
    .filter(id => server.files.has(`${GALLERY_SEGMENT_PREFIX}${id}.json`))
    .map(id => server.json(`${GALLERY_SEGMENT_PREFIX}${id}.json`).results));
  assert.deepEqual(Object.keys(written).sort(), ['a', 'b'], '分片里是本实现的格式，只有可用的两条');
  assert.equal(written.a.prompt, 'cat');
  assert.equal('promptSnapshot' in written.a, false);
  assert.deepEqual(server.json(GALLERY_METADATA_FILE), forkDocument, '旧文件原样留着');
});

test('改动先落内存、文件延后合并写；写失败内存照旧是最新的，下一次写一起带上', async () => {
  const store = createMemoryGalleryMetadataStore(null, { flushDelayMs: 50 });
  await store.initialize();
  await store.putMany([{ resultId: 'a', status: 'available', prompt: 'a' }]);
  await store.putMany([{ resultId: 'b', status: 'available', prompt: 'b' }]);
  assert.equal(store.has('b'), true, '内存里立刻能读到');
  assert.equal(store.writes, 0, '还没到点');
  await store.flush();
  assert.equal(store.writes, 1, '两次改动合成一次写');
  assert.deepEqual(Object.keys(store.document.results).sort(), ['a', 'b']);
  assert.equal(store.records().length, 2, 'records() 给原件，不拷贝');

  let failOnce = true;
  let written = null;
  const flaky = (await import('../../src/ui/api/gallery-metadata-store.js')).createGalleryMetadataStore({
    readDocument: async () => ({ schemaVersion: 1, results: {} }),
    writeDocument: async document => {
      if (failOnce) { failOnce = false; throw new Error('upload failed'); }
      written = JSON.parse(JSON.stringify(document));
    },
  });
  await flaky.initialize();
  await flaky.putMany([{ resultId: 'x', status: 'available', prompt: 'x' }]);
  await assert.rejects(flaky.flush(), /upload failed/);
  assert.equal(flaky.has('x'), true, '写失败内存不回退');
  await flaky.putMany([{ resultId: 'y', status: 'available', prompt: 'y' }]);
  await flaky.flush();
  assert.deepEqual(Object.keys(written.results).sort(), ['x', 'y'], '上一次没写成的随这一次一起写进去');
});
