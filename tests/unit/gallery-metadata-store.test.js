import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_METADATA_FILE,
  createSillyTavernGalleryMetadataStore,
} from '../../src/ui/api/gallery-metadata-store.js';

test('直连画廊通过 SillyTavern 用户文件接口读写独立 JSON', async () => {
  const calls = [];
  const store = createSillyTavernGalleryMetadataStore({
    headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
  }, async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).startsWith('/user/files/st-image-atelier-gallery.json?')) {
      return new Response('', { status: 404 });
    }
    if (url === '/api/files/upload') return new Response(JSON.stringify({ path: 'user/files/file.json' }));
    throw new Error(`Unexpected URL: ${url}`);
  });

  await store.initialize({
    legacyItems: [{
      resultId: 'legacy',
      status: 'available',
      prompt: 'old',
      promptSnapshot: 'actual',
      resolvedPrompt: 'resolved',
    }],
  });
  const upload = calls.find(call => call.url === '/api/files/upload');
  const body = JSON.parse(upload.options.body);
  assert.equal(body.name, GALLERY_METADATA_FILE);
  const written = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8'));
  assert.equal(written.results.legacy.prompt, 'actual');
  assert.equal('promptSnapshot' in written.results.legacy, false);
  assert.equal('resolvedPrompt' in written.results.legacy, false);
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
  const writes = [];
  const store = createSillyTavernGalleryMetadataStore({ headers: () => ({}) }, async (url, options = {}) => {
    if (String(url).startsWith('/user/files/st-image-atelier-gallery.json?')) {
      return new Response(JSON.stringify(forkDocument), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/files/upload') {
      writes.push(JSON.parse(Buffer.from(JSON.parse(options.body).data, 'base64').toString('utf8')));
      return new Response(JSON.stringify({ path: 'user/files/st-image-atelier-gallery.json' }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  await store.initialize();
  const values = store.values();
  assert.deepEqual(values.map(item => item.resultId).sort(), ['a', 'b'], 'deleted 的丢掉，可用的一条不少');
  const a = store.get('a');
  assert.equal(a.prompt, 'cat');
  assert.equal(a.negativePrompt, 'lowres');
  assert.equal(a.favorite, true);
  assert.equal('promptSnapshot' in a, false);
  assert.equal(store.get('b').provider, 'novelai');
  assert.ok(writes.length >= 1, '格式转换后应改写成本实现的格式');
  assert.deepEqual(Object.keys(writes.at(-1).results).sort(), ['a', 'b']);
});
