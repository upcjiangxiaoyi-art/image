/* 画廊元数据搬出 settings.json —— 1.6.2
   起因：926 条画廊记录、每条三份 4500 字提示词、876 条只是打了 deleted 标，
   settings.json 撑到 22.9MB，酒馆保存失败、全局设置被重置。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  GALLERY_FILE_NAME,
  createGalleryStore,
  deriveResultPrompts,
  isSlimGalleryResult,
  slimGalleryResult,
  tombstoneFields,
} from '../../src/ui/gallery/gallery-store.js';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { createFilesApiMock } from '../mocks/files-api.js';

const LONG_PROMPT = 'Medium and style (hard rules): '.repeat(150);

function legacyResult(name, status = 'available', extra = {}) {
  return {
    resultId: `result-${name}`,
    tagId: 'tag-1',
    attemptId: `attempt-${name}`,
    prompt: LONG_PROMPT,
    promptSnapshot: LONG_PROMPT,
    resolvedPrompt: LONG_PROMPT,
    negativePromptSnapshot: 'lowres',
    resolvedNegativePrompt: 'artist-negative, lowres',
    apiModel: 'gpt-image-1',
    localRelativePath: `user/images/st-image-atelier/${name}.png`,
    status,
    createdAt: '2026-09-12T00:00:00.000Z',
    deletedAt: status === 'deleted' ? '2026-09-12T01:00:00.000Z' : null,
    ...extra,
  };
}

function clientWith({ files, extensionSettings = {}, chat = [], onSettingsSave = () => {}, onChatSave = async () => {} }) {
  return createDirectApiClient({
    compat: { chat: () => chat, save: onChatSave, headers: () => ({ 'Content-Type': 'application/json' }) },
    extensionSettings,
    saveSettingsDebounced: onSettingsSave,
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    galleryStore: createGalleryStore({ fetchImpl: files.handle, log: null }),
  });
}

test('瘦身：三份提示词只留 promptSnapshot，派生字段和 deletedAt 一并去掉', () => {
  const slim = slimGalleryResult(legacyResult('a'));
  assert.equal(slim.promptSnapshot, LONG_PROMPT);
  assert.equal('prompt' in slim, false);
  assert.equal('resolvedPrompt' in slim, false);
  assert.equal('resolvedNegativePrompt' in slim, false);
  assert.equal('deletedAt' in slim, false);
  assert.equal(slim.negativePromptSnapshot, 'lowres');
  assert.ok(isSlimGalleryResult(slim));
  assert.ok(JSON.stringify(slim).length < JSON.stringify(legacyResult('a')).length / 2, '体积至少减半');
});

test('瘦身：旧记录缺 promptSnapshot 时按 prompt、resolvedPrompt 顺序回退', () => {
  assert.equal(slimGalleryResult({ resultId: 'x', prompt: 'p', resolvedPrompt: 'r' }).promptSnapshot, 'p');
  assert.equal(slimGalleryResult({ resultId: 'x', resolvedPrompt: 'r' }).promptSnapshot, 'r');
  assert.equal(slimGalleryResult({ resultId: 'x', resolvedNegativePrompt: 'neg' }).negativePromptSnapshot, 'neg');
});

test('派生：prompt 取标签原文，resolvedPrompt 由 promptSnapshot + 画师串拼出', () => {
  const derived = deriveResultPrompts(
    { promptSnapshot: 'a cat', artistPromptSnapshot: 'artist:x', provider: 'novelai' },
    { tag: { prompt: 'original' }, composeNovelAi: (prompt, artist) => `${artist} | ${prompt} | quality` },
  );
  assert.deepEqual(derived, { prompt: 'original', promptSnapshot: 'a cat', resolvedPrompt: 'artist:x | a cat | quality' });
  assert.equal(deriveResultPrompts({ promptSnapshot: 'a cat', provider: 'openai' }).resolvedPrompt, 'a cat');
});

test('墓碑只有识别信息，没有提示词', () => {
  const tombstone = tombstoneFields(legacyResult('a'), '2026-09-12T02:00:00.000Z');
  assert.deepEqual(Object.keys(tombstone).sort(), ['attemptId', 'deletedAt', 'favorite', 'generationIndex', 'resultId', 'status', 'tagId']);
  assert.equal(slimGalleryResult(legacyResult('d', 'deleted')).status, 'deleted');
  assert.equal('promptSnapshot' in slimGalleryResult(legacyResult('d', 'deleted')), false);
});

test('存储：文件不存在从空开始，写入后能读回，连续改动合并成串行写', async () => {
  const files = createFilesApiMock();
  const store = createGalleryStore({ fetchImpl: files.handle, log: null });
  const loaded = await store.load();
  assert.deepEqual(loaded, { items: [], missing: true });
  store.add([{ resultId: 'r1', status: 'available' }]);
  const first = store.persist();
  store.add([{ resultId: 'r2', status: 'available' }]);
  const second = store.persist();
  assert.equal(first, second, '写入进行中再改动，复用同一轮写入');
  await second;
  const document = files.read(GALLERY_FILE_NAME);
  assert.equal(document.version, 1);
  assert.deepEqual(document.items.map(item => item.resultId), ['r1', 'r2']);

  const reopened = createGalleryStore({ fetchImpl: files.handle, log: null });
  assert.deepEqual((await reopened.load()).items.map(item => item.resultId), ['r1', 'r2']);
});

test('存储：写入失败会抛错并记录，不会吞掉', async () => {
  const store = createGalleryStore({
    fetchImpl: async url => (url === '/api/files/upload'
      ? new Response('disk full', { status: 500 })
      : new Response('', { status: 404 })),
    log: null,
  });
  await store.load();
  store.add([{ resultId: 'r1', status: 'available' }]);
  await assert.rejects(store.persist(), /HTTP 500/);
  assert.match(String(store.lastError()), /HTTP 500/);
});

test('迁移：旧 settings 里的画廊搬进文件，deleted 的丢掉，settings 只剩设置项', async () => {
  const files = createFilesApiMock();
  const extensionSettings = {
    stImageAtelier: {
      settings: { enabled: true },
      presets: [{ id: 'p1', name: '预设' }],
      activePresetId: 'p1',
      gallery: [
        legacyResult('live-1'),
        legacyResult('gone-1', 'deleted'),
        legacyResult('live-2'),
        legacyResult('gone-2'),
      ],
      deletedResultIds: ['result-gone-1', 'result-gone-2'],
    },
  };
  let settingsSaves = 0;
  const client = clientWith({ files, extensionSettings, onSettingsSave: () => { settingsSaves += 1; } });
  const before = JSON.stringify(extensionSettings).length;
  const page = await client.gallery();
  assert.deepEqual(page.items.map(item => item.resultId).sort(), ['result-live-1', 'result-live-2']);
  assert.equal(settingsSaves, 1, '搬完落盘一次');
  const namespace = extensionSettings.stImageAtelier;
  assert.deepEqual(Object.keys(namespace).sort(), [
    'activeArtistPresetId', 'activePresetId', 'artistPresets', 'novelAi', 'presets', 'schemaVersion', 'settings',
  ]);
  assert.equal(namespace.schemaVersion, 7);
  assert.ok(JSON.stringify(extensionSettings).length < before / 4, 'settings 体积大幅缩小');
  const stored = files.read(GALLERY_FILE_NAME).items;
  assert.equal(stored.length, 2);
  assert.ok(stored.every(isSlimGalleryResult), '文件里每条都是单份提示词');
});

test('迁移：文件写不进去时旧数据原样留在 settings，不会先删后丢', async () => {
  const extensionSettings = { stImageAtelier: { gallery: [legacyResult('live-1')] } };
  const client = createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    galleryStore: createGalleryStore({
      fetchImpl: async url => (url === '/api/files/upload'
        ? new Response('nope', { status: 500 })
        : new Response('', { status: 404 })),
      log: null,
    }),
  });
  await assert.rejects(client.gallery(), /画廊索引文件不可用/);
  assert.equal(extensionSettings.stImageAtelier.gallery.length, 1, '旧画廊没被删');
});

test('迁移：文件已存在时以文件为准，settings 里的补进去、重复的跳过', async () => {
  const files = createFilesApiMock();
  files.write(GALLERY_FILE_NAME, { version: 1, items: [slimGalleryResult(legacyResult('shared', 'available', { favorite: true }))] });
  const extensionSettings = { stImageAtelier: { gallery: [legacyResult('shared'), legacyResult('only-settings')] } };
  const client = clientWith({ files, extensionSettings });
  const items = (await client.galleryMetadata()).items;
  assert.deepEqual(items.map(item => item.resultId).sort(), ['result-only-settings', 'result-shared']);
  assert.equal(items.find(item => item.resultId === 'result-shared').favorite, true, '文件里的收藏状态优先');
});

test('删除改真删：索引里移除、文件删掉、聊天里留小墓碑、settings 一字不动', async () => {
  const files = createFilesApiMock();
  const live = legacyResult('live');
  const tag = { tagId: 'tag-1', results: [structuredClone(live)], resultIds: [live.resultId], latestResultId: live.resultId, attempts: [] };
  const chat = [{ extra: { stImageAtelier: { tags: [tag] } } }];
  const extensionSettings = { stImageAtelier: { gallery: [live] } };
  const deletedPaths = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/delete') {
      deletedPaths.push(JSON.parse(options.body).path);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const client = clientWith({ files, extensionSettings, chat });
    await client.gallery();
    const settled = JSON.stringify(extensionSettings);
    await client.deleteResult(live.resultId);
    assert.deepEqual(deletedPaths, [live.localRelativePath]);
    assert.equal((await client.gallery()).items.length, 0);
    assert.equal(files.read(GALLERY_FILE_NAME).items.length, 0);
    assert.equal(JSON.stringify(extensionSettings), settled, '删除不碰 settings');
    assert.equal(tag.results[0].status, 'deleted');
    assert.equal('promptSnapshot' in tag.results[0], false);
    assert.equal(tag.autoSuppressed, true);
    const [state] = await client.resolveTags(['tag-1']);
    assert.equal(state.results.filter(item => item.status === 'available').length, 0, '墓碑拦住了回填');
    assert.equal(files.read(GALLERY_FILE_NAME).items.length, 0, '刷新后不会长回来');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('聊天元数据里的旧三份提示词在读取时就地瘦身，回填画廊时也是单份', async () => {
  const files = createFilesApiMock();
  const result = legacyResult('chat-only');
  const tag = { tagId: 'tag-1', results: [result], resultIds: [result.resultId], latestResultId: result.resultId, attempts: [] };
  let chatSaves = 0;
  const client = clientWith({ files, chat: [{ extra: { stImageAtelier: { tags: [tag] } } }], onChatSave: async () => { chatSaves += 1; } });
  const [state] = await client.resolveTags(['tag-1']);
  assert.ok(isSlimGalleryResult(result), '聊天里的对象被就地改瘦');
  assert.equal(chatSaves, 1, '瘦身后落盘一次');
  assert.equal(state.results[0].promptSnapshot, LONG_PROMPT);
  const stored = files.read(GALLERY_FILE_NAME).items;
  assert.equal(stored.length, 1);
  assert.ok(isSlimGalleryResult(stored[0]));
  assert.equal(client.fileUrl(result.resultId), `/${result.localRelativePath}`);
});

test('验证方式：连续新增画廊记录，settings 序列化长度一个字节都不变', async () => {
  const files = createFilesApiMock();
  const extensionSettings = { stImageAtelier: { settings: { enabled: true } } };
  const client = clientWith({ files, extensionSettings });
  await client.gallery();
  const baseline = JSON.stringify(extensionSettings).length;
  for (let index = 0; index < 5; index += 1) {
    const result = legacyResult(crypto.randomUUID());
    const tag = { tagId: `tag-${index}`, results: [result], resultIds: [result.resultId], latestResultId: result.resultId, attempts: [] };
    const found = { extra: { stImageAtelier: { tags: [tag] } } };
    const scoped = createDirectApiClient({
      compat: { chat: () => [found], save: async () => {}, headers: () => ({}) },
      extensionSettings,
      saveSettingsDebounced: () => {},
      keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      galleryStore: createGalleryStore({ fetchImpl: files.handle, log: null }),
    });
    await scoped.resolveTags([`tag-${index}`]);
    assert.equal(JSON.stringify(extensionSettings).length, baseline, `第 ${index + 1} 条之后 settings 体积不变`);
  }
  assert.equal(files.read(GALLERY_FILE_NAME).items.length, 5);
});
