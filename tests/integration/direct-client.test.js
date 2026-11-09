import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { createMemoryGalleryMetadataStore } from '../../src/ui/api/gallery-metadata-store.js';
import { createMemoryAttemptStore } from '../../src/ui/api/attempt-store.js';
import { createChatTagStore, createMemoryChatTagStore } from '../../src/ui/api/chat-tag-store.js';
import { PNG_BASE64, startMockUpstream } from '../mocks/mock-upstream.js';
import { byteLength } from '../../src/ui/state/tag-footprint.js';

/* node --test 多文件并行跑时，子进程里零散的 console 输出偶尔会把运行器的消息流搅坏
   （Unable to deserialize cloned data）。插件代码的 info / warn 在这一文件里只收进内存；要断言的用例自己再接管。 */
export const quietConsole = [];
for (const level of ['info', 'warn']) {
  console[level] = (...args) => { quietConsole.push([level, ...args]); };
}

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function storedZip(name, data) {
  const nameBytes = Buffer.from(name);
  const body = Buffer.from(data);
  const local = Buffer.alloc(30 + nameBytes.length + body.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  body.copy(local, 30 + nameBytes.length);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

test('仓库链接直装模式完成生成、幂等、画廊与删除', async t => {
  const upstream = await startMockUpstream();
  const originalFetch = globalThis.fetch;
  const uploads = new Map();
  let deleteCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      const path = `user/images/st-image-atelier/${body.filename}.${body.format}`;
      uploads.set(path, body.image);
      return response(200, { path });
    }
    if (url === '/api/images/delete') {
      const body = JSON.parse(options.body);
      deleteCalls += 1;
      uploads.delete(body.path);
      return response(200, {});
    }
    return originalFetch(url, options);
  };

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw>',
    extra: {
      stImageAtelier: {
        messageUuid,
        schemaVersion: 2,
        tags: [{
          tagId,
          prompt: 'base64',
          ordinal: 0,
          count: 1,
          attempts: [],
          results: [],
          resultIds: [],
          latestResultId: null,
          autoAttempted: false,
          autoSuppressed: false,
        }],
      },
    },
  };
  let chatSaves = 0;
  let settingsSaves = 0;
  const storage = new Map();
  const extensionSettings = {};
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => { chatSaves += 1; },
      headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => { settingsSaves += 1; },
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });

  await client.updateSettings({ allowHttp: true });
  await client.updatePreset({
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });
  const models = await client.listModels();
  assert.deepEqual(models.models, [{ id: 'gpt-image-1', ownedBy: 'mock' }]);

  const attemptId = crypto.randomUUID();
  const input = {
    tagId,
    attemptId,
    requestMode: 'manual',
    prompt: 'base64',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1, ratio: 'square' },
  };
  const legacySnapshot = JSON.stringify(message.extra.stImageAtelier);
  const attempt = await client.generate(input);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.resultIds.length, 1);
  assert.equal(uploads.size, 1);
  assert.equal(chatSaves, 0, '出图不再保存聊天：图片引用写进侧文件');
  assert.ok(settingsSaves >= 3);
  const record = client.tagRecord(tagId);
  assert.deepEqual(record.resultRefs.map(ref => ref.resultId), attempt.resultIds, '侧文件里记着图片引用');
  assert.match(record.resultRefs[0].path, /^user\/images\/st-image-atelier\//);
  assert.equal(JSON.stringify(message.extra.stImageAtelier), legacySnapshot, '旧格式的楼原样不动');

  const duplicate = await client.generate(input);
  assert.equal(duplicate.attemptId, attemptId);
  assert.equal(upstream.state.generationCalls, 1);

  const cancelId = crypto.randomUUID();
  const pending = client.generate({
    ...input,
    attemptId: cancelId,
    prompt: 'timeout',
  });
  while (upstream.state.generationCalls < 2) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const activeState = (await client.resolveTags([tagId]))[0];
  assert.notEqual(
    activeState.attempts.find(item => item.attemptId === cancelId)?.status,
    'interrupted',
  );
  await client.cancel(cancelId);
  assert.equal((await pending).status, 'cancelled');

  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results[0].status, 'available');
  assert.match(client.fileUrl(state.results[0].resultId), /^\/user\/images\//);
  const page = await client.gallery();
  assert.equal(page.items.length, 1);

  await client.deleteResult(state.results[0].resultId);
  assert.equal(deleteCalls, 1);
  assert.equal(chatSaves, 0, '删除图片也不保存聊天：记录在侧文件里');
  assert.equal((await client.gallery()).items.length, 0);
  assert.equal((await client.resolveTags([tagId]))[0].tag.autoSuppressed, true);
  assert.deepEqual(client.tagRecord(tagId).resultRefs, [], '引用一起删掉，不留墓碑');

  const serializedSettings = JSON.stringify(extensionSettings);
  assert.doesNotMatch(serializedSettings, /sk-test/);

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await upstream.close();
  });
});

test('保存触发消息重绘时不会把当前自动任务误判为 interrupted', async t => {
  const upstream = await startMockUpstream();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    return originalFetch(url, options);
  };

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw>',
    extra: {
      stImageAtelier: {
        messageUuid,
        schemaVersion: 2,
        tags: [{
          tagId,
          prompt: 'base64',
          ordinal: 0,
          count: 1,
          attempts: [],
          results: [],
          resultIds: [],
          latestResultId: null,
          autoAttempted: false,
          autoSuppressed: false,
        }],
      },
    },
  };
  const storage = new Map();
  const observedStatuses = [];
  let client;
  let saves = 0;
  const compat = {
    chat: () => [message],
    save: async () => { saves += 1; },
    headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
  };
  client = createDirectApiClient({
    compat,
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  await client.updateSettings({ allowHttp: true });
  await client.updatePreset({
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });

  const pending = client.generate({
    tagId,
    attemptId: `auto:${tagId}`,
    requestMode: 'auto',
    prompt: 'base64',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1, ratio: 'square' },
  });
  /* 生成还在路上时读状态（酒馆重绘、切回来都会读）：不能把正在跑的记录判成中断，也不保存聊天。 */
  while (upstream.state.generationCalls < 1) await new Promise(resolve => setTimeout(resolve, 5));
  const [during] = await client.resolveTags([tagId]);
  observedStatuses.push(during.attempts[0]?.status || 'none');
  const attempt = await pending;
  const [state] = await client.resolveTags([tagId]);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(saves, 0, '自动生图的标记记在侧文件里，不保存聊天');
  assert.equal(client.tagRecord(tagId).autoAttempted, true);
  assert.equal(state.attempts[0].status, 'succeeded');
  assert.equal(state.results.length, 1);
  assert.equal(observedStatuses.includes('interrupted'), false);
  assert.equal(observedStatuses.includes('queued'), false);
  assert.ok(['generating', 'downloading', 'saving', 'succeeded'].includes(observedStatuses[0]), `读到的是进行中或终态：${observedStatuses[0]}`);
  assert.equal(upstream.state.generationCalls, 1);

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await upstream.close();
  });
});

test('GPT 临时提示词覆盖只用于本次请求，保存快照且不改原标签，并可持久收藏', async t => {
  const originalFetch = globalThis.fetch;
  const requestBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://api.example.com/v1/images/generations') {
      requestBodies.push(JSON.parse(options.body));
      if (requestBodies.length === 1) {
        return response(400, { error: { message: "Unknown parameter: 'response_format'." } });
      }
      return response(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const originalMes = '<draw>original prompt</draw>';
  const tag = {
    tagId,
    prompt: 'original prompt',
    ordinal: 0,
    attempts: [],
    results: [],
    resultIds: [],
    latestResultId: null,
  };
  const message = {
    mes: originalMes,
    extra: { stImageAtelier: { messageUuid, tags: [tag] } },
  };
  const storage = new Map();
  const extensionSettings = {};
  const options = {
    compat: {
      chat: () => [message],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  };
  const client = createDirectApiClient(options);
  await client.updateSettings({ enableSmartRetry: true });
  await client.updatePreset({
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });
  const attempt = await client.generate({
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    prompt: 'temporary changed prompt',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1 },
  });
  assert.equal(requestBodies[0].prompt, 'temporary changed prompt');
  assert.equal(requestBodies.length, 2);
  assert.equal('response_format' in requestBodies[1], false);
  assert.equal(tag.prompt, 'original prompt');
  assert.equal(message.mes, originalMes);
  const [state] = await client.resolveTags([tagId]);
  const result = state.results.find(value => value.resultId === attempt.resultIds[0]);
  assert.equal(result.prompt, 'temporary changed prompt');
  assert.equal('promptSnapshot' in result, false);
  assert.equal('resolvedPrompt' in result, false);
  assert.deepEqual(result.compatibilityRetry.adjustedParameters, ['response_format']);

  await client.setFavorite(result.resultId, true);
  assert.equal((await client.galleryMetadata()).items[0].favorite, true);
  assert.equal('gallery' in extensionSettings.stImageAtelier, false);
  const reloaded = createDirectApiClient(options);
  assert.equal((await reloaded.galleryMetadata()).items[0].favorite, true);
});

test('旧版单预设迁移为多预设，且每个预设独立保存密钥', async () => {
  const storage = new Map([['stImageAtelier.directApiKey.v1', 'sk-legacy']]);
  const extensionSettings = {
    stImageAtelier: {
      preset: {
        id: 'default',
        name: '旧版主站',
        baseUrl: 'https://api.example.com',
        selectedModel: 'model-old',
      },
    },
  };
  const client = createDirectApiClient({
    compat: {
      chat: () => [],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });

  let data = await client.getPresets();
  assert.equal(data.activePresetId, 'default');
  assert.equal(data.items[0].name, '旧版主站');
  assert.equal(data.items[0].hasApiKey, true);
  assert.equal(extensionSettings.stImageAtelier.preset, undefined);
  assert.equal(extensionSettings.stImageAtelier.presets.length, 1);

  const backup = await client.createPreset({ name: '备用 API' });
  await client.updatePreset(backup.id, {
    baseUrl: 'https://backup.example.com',
    apiKey: 'sk-backup',
    selectedModel: 'model-new',
  });
  data = await client.getPresets();
  assert.equal(data.items.length, 2);
  assert.equal(data.activePresetId, backup.id);
  assert.equal(data.items.find(item => item.id === backup.id).hasApiKey, true);

  await client.clearSecret(backup.id);
  data = await client.getPresets();
  assert.equal(data.items.find(item => item.id === backup.id).hasApiKey, false);
  assert.equal(data.items.find(item => item.id === 'default').hasApiKey, true);

  const selected = await client.selectPreset('default');
  assert.equal(selected.name, '旧版主站');
  const removed = await client.deletePreset(backup.id);
  assert.equal(removed.activePreset.id, 'default');
  assert.equal((await client.getPresets()).items.length, 1);
  assert.doesNotMatch(JSON.stringify(extensionSettings), /sk-(?:legacy|backup)/);
});

test('NovelAI 引擎使用独立 Token、画师串预设并保存生成结果', async t => {
  const originalFetch = globalThis.fetch;
  const png = Buffer.from(PNG_BASE64, 'base64');
  const zip = storedZip('image_0.png', png);
  let novelAiRequest;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://nai.example/ai/generate-image') {
      novelAiRequest = { options, body: JSON.parse(options.body) };
      return new Response(zip, {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      });
    }
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>1girl, sunset</draw>',
    extra: {
      stImageAtelier: {
        messageUuid,
        schemaVersion: 4,
        tags: [{
          tagId,
          prompt: '1girl, sunset',
          ordinal: 0,
          count: 1,
          attempts: [],
          results: [],
          resultIds: [],
          latestResultId: null,
          autoAttempted: false,
          autoSuppressed: false,
        }],
      },
    },
  };
  const storage = new Map();
  const extensionSettings = {};
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  await client.updateSettings({ generationProvider: 'novelai' });
  await client.updateNovelAi({
    baseUrl: 'https://nai.example',
    apiKey: 'nai-secret-token',
    model: 'nai-diffusion-4-5-full',
    defaultSize: '512x768',
    seed: 42,
  });
  const novelAiData = await client.getNovelAi();
  const artist = await client.updateArtistPreset(novelAiData.activeArtistPresetId, {
    name: '柔光画师串',
    prompt: 'artist:sample, soft lighting',
    negativePrompt: 'artist negative anatomy',
  });

  const attempt = await client.generate({
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    provider: 'novelai',
    artistPresetId: artist.id,
    prompt: '1girl, moonlight',
    negativePromptOverride: 'bad hands, lowres',
    chatId: 'chat-nai',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1 },
  });
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.provider, 'novelai');
  assert.equal(attempt.artistPresetNameSnapshot, '柔光画师串');
  assert.equal(attempt.generationSeed, 42);
  assert.equal(novelAiRequest.options.headers.Authorization, 'Bearer nai-secret-token');
  assert.match(novelAiRequest.body.input, /^artist:sample, soft lighting, 1girl, moonlight/);
  assert.match(
    novelAiRequest.body.parameters.negative_prompt,
    /^artist negative anatomy, bad hands, lowres/,
  );
  assert.equal(novelAiRequest.body.parameters.width, 512);
  assert.equal(novelAiRequest.body.parameters.height, 768);

  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].provider, 'novelai');
  assert.equal(state.results[0].prompt, '1girl, moonlight');
  assert.equal(state.results[0].negativePrompt, 'bad hands, lowres');
  assert.equal(message.extra.stImageAtelier.tags[0].prompt, '1girl, sunset');
  assert.equal(message.mes, '<draw>1girl, sunset</draw>');
  assert.equal(state.results[0].artistPresetNameSnapshot, '柔光画师串');
  assert.equal(state.results[0].generationSeed, 42);
  assert.doesNotMatch(JSON.stringify(extensionSettings), /nai-secret-token/);
});

test('直连画廊按时间或数量自动清理，合并并发检查且真删元数据', async t => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const tagId = crypto.randomUUID();
  const values = [
    { age: 10, name: 'expired' },
    { age: 5, name: 'overflow' },
    { age: 2, name: 'middle' },
    { age: 1, name: 'newest' },
  ].map(({ age, name }) => ({
    resultId: crypto.randomUUID(),
    tagId,
    prompt: name,
    apiModel: 'test-model',
    localRelativePath: `user/images/st-image-atelier/${name}.png`,
    status: 'available',
    createdAt: new Date(now - age * 24 * 60 * 60 * 1000).toISOString(),
    deletedAt: null,
  }));
  const deletedPaths = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, '/api/images/delete');
    deletedPaths.push(JSON.parse(options.body).path);
    return response(200, {});
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tag = {
    tagId,
    results: structuredClone(values),
    resultIds: values.map(item => item.resultId),
    latestResultId: values.at(-1).resultId,
    attempts: [],
    autoSuppressed: false,
  };
  const message = { extra: { stImageAtelier: { tags: [tag] } } };
  let chatSaves = 0;
  let settingsSaves = 0;
  const extensionSettings = {
    stImageAtelier: {
      settings: {
        galleryCleanupByAge: true,
        galleryMaxAgeDays: 7,
        galleryCleanupByCount: true,
        galleryMaxCount: 2,
      },
      gallery: structuredClone(values),
    },
  };
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => { chatSaves += 1; },
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => { settingsSaves += 1; },
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });

  const [first, second] = await Promise.all([client.cleanupGallery(), client.cleanupGallery()]);
  assert.deepEqual(first, second);
  assert.equal(first.deletedCount, 2);
  assert.equal(first.keptCount, 2);
  assert.equal(first.byAgeCount, 1);
  assert.equal(first.byCountCount, 2);
  assert.deepEqual(deletedPaths, values.slice(0, 2).map(item => item.localRelativePath));
  assert.equal(chatSaves, 0, '清理不保存聊天：记录在侧文件里');
  assert.equal(settingsSaves, 1);
  const record = client.tagRecord(tag.tagId);
  assert.equal(record.autoSuppressed, true);
  assert.deepEqual(record.resultRefs.map(ref => ref.resultId), values.slice(2).map(item => item.resultId));
  assert.equal('resultIds' in tag, true, '旧格式的楼原样不动，由「整理旧数据」一次换成引用');
  assert.equal(tag.latestResultId, values.at(-1).resultId);
  assert.deepEqual((await client.gallery()).items.map(item => item.resultId), [
    values[3].resultId,
    values[2].resultId,
  ]);
  assert.equal((await client.resolveTags([tagId]))[0].results.length, 2);
  assert.equal('results' in tag, true, '旧格式原样不动');
  assert.equal('gallery' in extensionSettings.stImageAtelier, false);
  assert.equal('deletedResultIds' in extensionSettings.stImageAtelier, false);
});

test('画廊元数据迁移后新增记录不改写 extension_settings', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://api.example.com/v1/images/generations') {
      return response(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const longPrompt = 'artist style, detailed lighting, '.repeat(150);
  const gallery = Array.from({ length: 50 }, (_, index) => ({
    resultId: crypto.randomUUID(),
    tagId: crypto.randomUUID(),
    prompt: longPrompt,
    promptSnapshot: longPrompt,
    resolvedPrompt: longPrompt,
    localRelativePath: `user/images/st-image-atelier/legacy-${index}.png`,
    mimeType: 'image/png',
    status: 'available',
    createdAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1000).toISOString(),
  }));
  const tagId = crypto.randomUUID();
  const message = {
    mes: '<draw>new prompt</draw>',
    extra: {
      stImageAtelier: {
        tags: [{
          tagId,
          prompt: 'new prompt',
          attempts: [],
          resultIds: [],
          latestResultId: null,
        }],
      },
    },
  };
  const extensionSettings = {
    stImageAtelier: {
      settings: { enabled: true },
      presets: [{
        id: 'default',
        name: '主站',
        baseUrl: 'https://api.example.com',
        selectedModel: 'gpt-image-1',
      }],
      artistPresets: [{ id: 'default', name: '默认画师串', prompt: '', negativePrompt: '' }],
      novelAi: {},
      activePresetId: 'default',
      activeArtistPresetId: 'default',
      gallery,
      deletedResultIds: [],
      schemaVersion: 6,
    },
  };
  const galleryStore = createMemoryGalleryMetadataStore();
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore,
    attemptStore: createMemoryAttemptStore(),
    keyStorage: {
      getItem: key => key === 'stImageAtelier.directApiKey.v2:default' ? 'sk-test' : null,
      setItem() {},
      removeItem() {},
    },
  });

  await client.getSettings();
  assert.deepEqual(Object.keys(extensionSettings.stImageAtelier).sort(), [
    'activeArtistPresetId',
    'activePresetId',
    'artistPresets',
    'defaultReferenceSetId',
    'novelAi',
    'presets',
    'referenceBindings',
    'referenceSets',
    'schemaVersion',
    'settings',
  ]);
  assert.equal(extensionSettings.stImageAtelier.schemaVersion, 8);
  const migrated = Object.values(galleryStore.document.results);
  assert.equal(migrated.length, 50);
  assert.equal(migrated[0].prompt, longPrompt);
  assert.equal('promptSnapshot' in migrated[0], false);
  assert.equal('resolvedPrompt' in migrated[0], false);

  const settingsBefore = JSON.stringify(extensionSettings);
  await client.generate({
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    prompt: 'new prompt',
    chatId: 'chat-1',
    messageUuid: crypto.randomUUID(),
    tagOrdinal: 0,
    parameters: { count: 1 },
  });
  const settingsAfter = JSON.stringify(extensionSettings);
  assert.equal(settingsAfter, settingsBefore);
  await galleryStore.flush();
  assert.equal(Object.keys(galleryStore.document.results).length, 51);
});

test('独立画廊文件写入失败时保留旧 settings 数据以便重试', async () => {
  const legacy = {
    resultId: crypto.randomUUID(),
    prompt: 'must survive',
    status: 'available',
  };
  const extensionSettings = {
    stImageAtelier: { gallery: [legacy], schemaVersion: 6 },
  };
  const client = createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: {
      initialize: async () => { throw new Error('disk full'); },
    },
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  await assert.rejects(client.getSettings(), /disk full/);
  assert.deepEqual(extensionSettings.stImageAtelier.gallery, [legacy]);
  assert.equal(extensionSettings.stImageAtelier.schemaVersion, 6);
});

test('已迁移版本不会从旧聊天副本复活已删除的画廊记录', async () => {
  const resultId = crypto.randomUUID();
  const tagId = crypto.randomUUID();
  const tag = {
    tagId,
    attempts: [],
    resultIds: [resultId],
    latestResultId: resultId,
    results: [{ resultId, tagId, prompt: 'stale', status: 'available' }],
  };
  const client = createDirectApiClient({
    compat: {
      chat: () => [{ extra: { stImageAtelier: { tags: [tag] } } }],
      save: async () => {},
      headers: () => ({}),
    },
    extensionSettings: { stImageAtelier: { schemaVersion: 8 } },
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 0);
  assert.equal('results' in tag, true, '旧格式原样不动');
  assert.deepEqual(client.tagRecord(tagId).resultRefs, [], '没有文件路径的旧记录不复活，引用也不留');
  assert.equal((await client.galleryMetadata()).total, 0);
});

/* 合流兼容（1.6.5）：旧版把整份记录复制在聊天 tag.results 里。升级后清理这份复制品之前，
   "可用、有文件、索引里没有"的要先补回索引，不然图从卡片上消失。 */
test('聊天里可用但索引里没有的旧记录，清理前补回画廊索引', async () => {
  const tagId = crypto.randomUUID();
  const orphan = {
    resultId: 'orphan-1',
    tagId,
    status: 'available',
    promptSnapshot: 'orphan prompt',
    localRelativePath: 'user/images/st-image-atelier/orphan-1.png',
    createdAt: '2026-09-13T00:00:00.000Z',
  };
  const tag = {
    tagId,
    prompt: 'orphan prompt',
    results: [orphan, { resultId: 'dead', status: 'deleted' }],
    resultIds: ['orphan-1'],
    latestResultId: 'orphan-1',
    attempts: [],
  };
  const message = { extra: { stImageAtelier: { tags: [tag] } } };
  const galleryStore = createMemoryGalleryMetadataStore();
  let chatSaves = 0;
  const client = createDirectApiClient({
    compat: { chat: () => [message], save: async () => { chatSaves += 1; }, headers: () => ({}) },
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    galleryStore,
    attemptStore: createMemoryAttemptStore(),
  });
  const [state] = await client.resolveTags([tagId]);
  assert.equal(Array.isArray(tag.results), true, '旧格式的楼原样不动（整理时再清）');
  assert.deepEqual(client.tagRecord(tagId).resultRefs.map(ref => ref.resultId), ['orphan-1'], '补回画廊后引用记在侧文件里');
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].prompt, 'orphan prompt');
  assert.equal(client.fileUrl('orphan-1'), '/user/images/st-image-atelier/orphan-1.png');
  await galleryStore.flush();
  assert.equal(Object.keys(galleryStore.document.results).length, 1, '补回了索引文件');
  assert.equal(chatSaves, 0, '补回画廊不动聊天');
});


function tagMetadata(tagId, messageUuid, prompt = 'base64') {
  return {
    messageUuid,
    schemaVersion: 2,
    tags: [{
      tagId,
      prompt,
      ordinal: 0,
      count: 1,
      attempts: [],
      resultIds: [],
      latestResultId: null,
      autoAttempted: false,
      autoSuppressed: false,
    }],
  };
}

/* 生图请求卡在半路，等测试把聊天改成「重 roll 之后」的样子再放行。 */
async function gatedClient(t, chat, {
  save = async () => {},
  saveSoon,
  attemptStore = createMemoryAttemptStore(),
  galleryStore = createMemoryGalleryMetadataStore(),
  verifyFile,
  /* 默认关掉缩略图：老用例数上传、数读取的次数，别被后台任务搅了；要测缩略图的用例自己传一个假的。 */
  thumbnailer = null,
  thumbnailDelayMs = 0,
  compatExtra = {},
  /* 聊天的生图标签侧文件：每个聊天（identity）一份内存版，测试里能看写了几次、写了什么。 */
  chatTagStore,
} = {}) {
  const tagStores = new Map();
  const chatTagStoreFactory = chatTagStore || (identity => {
    const key = `${identity.characterKey}|${identity.chatId}`;
    if (!tagStores.has(key)) tagStores.set(key, createMemoryChatTagStore(null, identity));
    return tagStores.get(key);
  });
  const originalFetch = globalThis.fetch;
  const requests = [];
  const deletedPaths = [];
  const uploads = [];
  const edits = [];
  const served = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      uploads.push(body);
      return response(200, { path: `user/images/${body.ch_name || 'st-image-atelier'}/${body.filename}.${body.format}` });
    }
    if (url === '/api/images/delete') {
      deletedPaths.push(JSON.parse(options.body).path);
      return response(200, {});
    }
    if (String(url).endsWith('/v1/images/generations')) {
      requests.push(JSON.parse(options.body));
      markStarted();
      await gate;
      return response(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    if (String(url).endsWith('/v1/images/edits')) {
      edits.push({ body: options.body, headers: options.headers || {} });
      markStarted();
      await gate;
      return response(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    if (String(url).startsWith('/user/images/')) {
      served.push(String(url));
      return new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    throw new Error(`意外的请求：${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const storage = new Map();
  const client = createDirectApiClient({
    compat: {
      chat: () => chat,
      save,
      ...(saveSoon ? { saveSoon } : {}),
      headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
      ...compatExtra,
    },
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    galleryStore,
    attemptStore,
    verifyFile,
    thumbnailer,
    thumbnailDelayMs,
    chatTagStore: chatTagStoreFactory,
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  await client.updatePreset({
    baseUrl: 'https://upstream.test',
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });
  return { client, requests, release, started, deletedPaths, uploads, edits, served, attemptStore, galleryStore, tagStores };
}

function leanMetadata(tagId, messageUuid, prompt = 'base64') {
  return {
    messageUuid,
    schemaVersion: 2,
    tags: [{
      tagId,
      prompt,
      ordinal: 0,
      count: 1,
      latestResultId: null,
      resultRefs: [],
      autoAttempted: false,
      autoSuppressed: false,
    }],
  };
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 5));

function generationInput(tagId, messageUuid) {
  return {
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    prompt: 'base64',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1, ratio: 'square' },
  };
}

test('画到一半滑到新的一版：图写回上一版的存档，滑回去就能看到，不再显示「生成被中断」', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw>',
    swipe_id: 0,
    swipes: ['<draw>base64</draw>'],
    swipe_info: [{ extra: {} }],
    extra: { stImageAtelier: tagMetadata(tagId, messageUuid) },
  };
  const { client, release, started } = await gatedClient(t, [message]);
  const pending = client.generate(generationInput(tagId, messageUuid));
  await started;

  /* 右滑生成新的一版：酒馆先把当前这一版深拷贝存档；新的一版写完后，画笺按新正文换上新标签。 */
  message.swipe_info[0].extra = structuredClone(message.extra);
  message.swipe_id = 1;
  message.swipes.push('<draw>another</draw>');
  message.mes = message.swipes[1];
  message.swipe_info.push({ extra: structuredClone(message.extra) });
  message.extra.stImageAtelier = tagMetadata(crypto.randomUUID(), messageUuid, 'another');
  const archivedSnapshot = JSON.stringify(message.swipe_info[0].extra);

  release();
  const attempt = await pending;
  assert.equal(attempt.status, 'succeeded');
  const record = client.tagRecord(tagId);
  assert.deepEqual(record.resultRefs.map(ref => ref.resultId), attempt.resultIds, '图片引用记在侧文件里，按 tagId，滑走了也写得到');
  assert.equal(record.latestResultId, attempt.resultIds[0]);
  assert.equal(JSON.stringify(message.swipe_info[0].extra), archivedSnapshot, '聊天里的存档一个字不动');
  assert.equal(client.tagRecord(message.extra.stImageAtelier.tags[0].tagId), null, '新的一版不受影响');

  /* 滑回上一版：酒馆把存档拷回来。 */
  message.swipe_info[1].extra = structuredClone(message.extra);
  message.swipe_id = 0;
  message.mes = message.swipes[0];
  message.extra = structuredClone(message.swipe_info[0].extra);
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.attempts[0].status, 'succeeded', '独立存储里记着已经画完');
  assert.deepEqual(state.results.map(result => result.resultId), attempt.resultIds);
});

test('回复被重新生成：图照样存进画廊；再看到停在「生成中」的旧记录时按画廊接回卡片', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw>',
    extra: { stImageAtelier: tagMetadata(tagId, messageUuid) },
  };
  const chat = [message];
  const { client, release, started } = await gatedClient(t, chat);
  const pending = client.generate(generationInput(tagId, messageUuid));
  await started;
  /* 聊天文件里这时存的是「生成中」；切走聊天再回来，读到的就是这一份。 */
  const savedWhileGenerating = structuredClone(message.extra);
  assert.deepEqual(savedWhileGenerating.stImageAtelier.tags[0].attempts, [], '生成中的记录也不写进聊天');

  chat.splice(0, 1, { is_user: false, mes: '重新生成的回复', extra: {} });
  release();
  const attempt = await pending;
  assert.equal(attempt.status, 'succeeded', '原来那条回复没了也不报错');
  const { items } = await client.galleryMetadata();
  assert.deepEqual(items.map(item => item.resultId), attempt.resultIds, '图存进了画廊');

  const lostTagId = crypto.randomUUID();
  const lost = {
    is_user: false,
    mes: '<draw>lost</draw>',
    extra: { stImageAtelier: tagMetadata(lostTagId, crypto.randomUUID(), 'lost') },
  };
  lost.extra.stImageAtelier.tags[0].attempts.push({
    attemptId: crypto.randomUUID(),
    tagId: lostTagId,
    status: 'generating',
  });
  chat.splice(0, chat.length, { is_user: false, mes: '<draw>base64</draw>', extra: savedWhileGenerating }, lost);
  const [recovered, interrupted] = await client.resolveTags([tagId, lostTagId]);
  assert.equal(recovered.attempts[0].status, 'succeeded', '独立存储里记着已经画完');
  assert.deepEqual(recovered.attempts[0].resultIds, attempt.resultIds);
  assert.deepEqual(recovered.results.map(result => result.resultId), attempt.resultIds, '聊天文件里还没记上的图按画廊接回卡片');
  assert.deepEqual(client.tagRecord(tagId).resultRefs.map(ref => ref.resultId), attempt.resultIds, '接回来的引用写进侧文件');
  assert.equal(recovered.tag.latestResultId, attempt.resultIds[0]);
  assert.equal(interrupted.attempts[0].status, 'interrupted', '聊天里旧版的「生成中」记录搬进独立存储；画廊里也没有才算中断');
});

test('这一层正在生成新的滑动版本时，排着队的旧标签在扣费前就停下', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '',
    swipe_id: 1,
    swipes: ['<draw>base64</draw>'],
    swipe_info: [{ extra: { stImageAtelier: tagMetadata(tagId, messageUuid) } }],
    extra: { stImageAtelier: tagMetadata(tagId, messageUuid) },
  };
  const { client, requests, release } = await gatedClient(t, [message]);
  release();
  await assert.rejects(
    client.generate(generationInput(tagId, messageUuid)),
    error => error.code === 'TAG_NOT_FOUND',
  );
  assert.equal(requests.length, 0, '没有发出生图请求');
  assert.deepEqual(message.swipe_info[0].extra.stImageAtelier.tags[0].attempts, [], '也没有写任何记录');
});

test('同一张卡同时画两张：后台那张晚到时不抢新图，两张都进历史；新的没画成时后台那张补上', async t => {
  const originalFetch = globalThis.fetch;
  const gates = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    if (String(url).endsWith('/v1/images/generations')) {
      const gate = {};
      gate.done = new Promise(resolve => { gate.release = resolve; });
      gates.push(gate);
      const outcome = await gate.done;
      return outcome === 'fail'
        ? response(502, { error: { message: 'upstream busy' } })
        : response(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    throw new Error(`意外的请求：${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const waitForRequests = async count => {
    while (gates.length < count) await new Promise(resolve => setTimeout(resolve, 5));
  };

  const tagId = crypto.randomUUID();
  const otherTagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw><draw>other</draw>',
    extra: { stImageAtelier: tagMetadata(tagId, messageUuid) },
  };
  message.extra.stImageAtelier.tags.push({ ...tagMetadata(otherTagId, messageUuid, 'other').tags[0], ordinal: 1 });
  const storage = new Map();
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
    },
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  await client.updatePreset({ baseUrl: 'https://upstream.test', apiKey: 'sk-test', selectedModel: 'gpt-image-1' });

  const slowInput = generationInput(tagId, messageUuid);
  const slow = client.generate(slowInput);
  await waitForRequests(1);
  const quickInput = generationInput(tagId, messageUuid);
  const quick = client.generate(quickInput);
  await waitForRequests(2);
  gates[1].release('ok');
  const newer = await quick;
  gates[0].release('ok');
  const older = await slow;
  assert.equal(newer.status, 'succeeded');
  assert.equal(older.status, 'succeeded', '后台那张照样画完存好');
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.tag.latestResultId, newer.resultIds[0], '卡片上还是新的那张');
  assert.deepEqual(
    [...state.tag.resultIds].sort(),
    [...newer.resultIds, ...older.resultIds].sort(),
    '两张都进了这张卡的历史',
  );
  assert.deepEqual(state.attempts.map(item => item.attemptId), [quickInput.attemptId, slowInput.attemptId]);

  const otherSlow = client.generate({ ...generationInput(otherTagId, messageUuid), prompt: 'other' });
  await waitForRequests(3);
  const otherQuick = client.generate({ ...generationInput(otherTagId, messageUuid), prompt: 'other' });
  await waitForRequests(4);
  gates[3].release('fail');
  await assert.rejects(otherQuick);
  gates[2].release('ok');
  const rescued = await otherSlow;
  const [other] = await client.resolveTags([otherTagId]);
  assert.equal(other.tag.latestResultId, rescued.resultIds[0], '新的那次没画成，后台那张画好就显示它');
});

test('老预设的超时：没改过的 3 分钟和原来的上限 10 分钟换成 1 小时，自己设的别的值不动，只迁一次', async () => {
  const extensionSettings = {
    stImageAtelier: {
      presets: [
        { id: 'untouched', name: '默认', timeoutMs: 180_000 },
        { id: 'maxed', name: '拉满', timeoutMs: 600_000 },
        { id: 'custom', name: '自己设的', timeoutMs: 300_000 },
      ],
      activePresetId: 'untouched',
    },
  };
  const options = {
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const client = createDirectApiClient(options);
  const timeouts = async target => Object.fromEntries((await target.getPresets()).items.map(item => [item.id, item.timeoutMs]));
  assert.deepEqual(await timeouts(client), { untouched: 3_600_000, maxed: 3_600_000, custom: 300_000 });
  const created = await client.createPreset({ name: '新的' });
  assert.equal(created.timeoutMs, 3_600_000, '新预设默认 1 小时');

  await client.updatePreset('untouched', { timeoutMs: 180_000 });
  const reloaded = createDirectApiClient({ ...options, galleryStore: createMemoryGalleryMetadataStore(), attemptStore: createMemoryAttemptStore() });
  assert.equal((await timeouts(reloaded)).untouched, 180_000, '迁过一次后自己改回 3 分钟，重新加载也不再动');
});

test('读状态不保存聊天：生成中读到的是「生成中」，画完读到的是终态', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw>',
    extra: { stImageAtelier: tagMetadata(tagId, messageUuid) },
  };
  /* 手机上酒馆保存聊天要排队，一次可能等好几秒：把「读状态」里那次保存卡住。 */
  const held = [];
  let holdSaves = false;
  const save = () => (holdSaves ? new Promise(resolve => held.push(resolve)) : Promise.resolve());
  const { client, release, started } = await gatedClient(t, [message], { save });
  holdSaves = true;
  const pending = client.generate(generationInput(tagId, messageUuid));
  await started;

  const [during] = await client.resolveTags([tagId]);
  assert.equal(during.attempts[0].status, 'generating', '生成中读到的就是生成中，不是中断');
  assert.equal(held.length, 0, '读状态不保存聊天');

  release();
  const attempt = await pending;
  assert.equal(attempt.status, 'succeeded');
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.attempts[0].status, 'succeeded');
  assert.deepEqual(state.results.map(result => result.resultId), attempt.resultIds);
  assert.equal(held.length, 0, '出图也不保存聊天');
});

test('读还没出图的卡片状态不会每次都整份保存聊天', async t => {
  const tagId = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: tagMetadata(tagId, crypto.randomUUID()) } };
  let saves = 0;
  const { client } = await gatedClient(t, [message], { save: async () => { saves += 1; } });
  await client.resolveTags([tagId]);
  const before = saves;
  for (let index = 0; index < 3; index += 1) await client.resolveTags([tagId]);
  assert.equal(saves, before, '没有改动就不保存');
});

test('每次生成记下实际发出去的画质：预设默认、「不发送」、额外请求参数 JSON 覆盖都算进去', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: tagMetadata(tagId, messageUuid) } };
  const { client, release, requests } = await gatedClient(t, [message]);
  release();
  const qualityOf = async patch => {
    await client.updatePreset(patch);
    const attempt = await client.generate(generationInput(tagId, messageUuid));
    return { snapshot: attempt.qualitySnapshot, sent: requests.at(-1).quality };
  };
  assert.deepEqual(await qualityOf({ defaultQuality: 'max', sendQuality: true }), { snapshot: 'max', sent: 'max' });
  assert.deepEqual(await qualityOf({ sendQuality: false }), { snapshot: '', sent: undefined }, '选了不发送');
  assert.deepEqual(
    await qualityOf({ sendQuality: true, defaultQuality: 'high', extraBody: { quality: 'xhigh' } }),
    { snapshot: 'xhigh', sent: 'xhigh' },
    '额外请求参数 JSON 最后覆盖',
  );
});

test('备用线路设置：默认不用、自动换默认关；删掉当备用线路的预设时一起清掉；自动换线路的说明记在生成记录上', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: tagMetadata(tagId, messageUuid) } };
  const { client, release } = await gatedClient(t, [message]);
  release();
  const defaults = await client.getSettings();
  assert.equal(defaults.backupPresetId, '');
  assert.equal(defaults.enableAutoFallback, false);

  const stable = await client.createPreset({ name: '稳定组' });
  await client.updatePreset(stable.id, { baseUrl: 'https://upstream.test', apiKey: 'sk-stable', selectedModel: 'gpt-image-1' });
  const saved = await client.updateSettings({ backupPresetId: stable.id, enableAutoFallback: true });
  assert.equal(saved.backupPresetId, stable.id);
  assert.equal(saved.enableAutoFallback, true);

  const attempt = await client.generate({
    ...generationInput(tagId, messageUuid),
    presetId: stable.id,
    statusMessage: '主线路连不上服务器，已换备用线路「稳定组」重画',
  });
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.presetNameSnapshot, '稳定组');
  assert.equal(attempt.statusMessage, null, '画完就清掉');

  await client.deletePreset(stable.id);
  assert.equal((await client.getSettings()).backupPresetId, '', '备用线路的预设删了，设置一起清掉');
});

/* 1.7.0：聊天文件膨胀的根因是每次生成都把整份记录（含好几份提示词复制品）写进楼层的 extra，
   每楼最多 50 条、每条几 KB，819 楼的聊天光 tags 就 18.7 MB，酒馆每次保存都整份上传重写。 */
test('出图不保存聊天、楼里只有一百来字节的引用：没有生成记录、没有提示词复制品；图片引用和记录在侧文件和独立存储里', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const prompt = '雨夜霓虹街道中的电影感人像，长发女子撑着透明伞，'.repeat(120);
  const message = { is_user: false, mes: `<draw>${prompt}</draw>`, extra: { stImageAtelier: { messageUuid, tagIds: [tagId] } } };
  let saves = 0;
  const { client, release, attemptStore, tagStores } = await gatedClient(t, [message], { save: async () => { saves += 1; } });
  release();
  for (let index = 0; index < 3; index += 1) {
    await client.generate({ ...generationInput(tagId, messageUuid), prompt });
  }
  assert.equal(saves, 0, '出图不保存聊天');
  assert.deepEqual(message.extra.stImageAtelier, { messageUuid, tagIds: [tagId] }, '楼里只有引用');
  assert.ok(byteLength(message.extra.stImageAtelier) < 120, `一楼的引用 ${byteLength(message.extra.stImageAtelier)} 字节`);
  assert.doesNotMatch(JSON.stringify(message.extra), /雨夜霓虹/, '聊天里没有第二份提示词');

  const record = client.tagRecord(tagId);
  assert.deepEqual(Object.keys(record), ['promptHash', 'latestResultId', 'resultRefs', 'autoAttempted', 'autoSuppressed']);
  assert.equal(record.resultRefs.length, 3);
  assert.deepEqual(Object.keys(record.resultRefs[0]), ['resultId', 'path', 'createdAt'], '每张图只记 id、路径、时间');
  assert.doesNotMatch(JSON.stringify(record), /雨夜霓虹/, '侧文件里也没有提示词，只有指纹');
  const [store] = [...tagStores.values()];
  await store.flush();
  assert.ok(store.writes >= 1, '侧文件写过');
  assert.equal('updatedAt' in store.document, false, '侧文件里没有时间戳');
  assert.deepEqual(Object.keys(store.document.tags), [tagId]);

  const stored = attemptStore.forTag(tagId);
  assert.equal(stored.length, 3);
  assert.equal(stored[0].status, 'succeeded');
  assert.equal('promptSnapshot' in stored[0], false, '和标签一样的提示词不再存一份');
  assert.equal('artistPromptSnapshot' in stored[0], false);
  assert.equal('resolvedPrompt' in stored[0], false);
  assert.ok(byteLength(stored[0]) < 1024, `一条生成记录 ${byteLength(stored[0])} 字节`);
  await attemptStore.flush();
  assert.ok(attemptStore.writes >= 3, '记录真的写进了独立文件');

  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.attempts[0].promptSnapshot, prompt, '读出来按正文里的提示词补回');
  assert.equal(state.results.length, 3);
  assert.equal(state.results[0].requestedSize, '1024x1024', '画质、尺寸、开始时间记在画廊记录里，生成记录清掉后卡片照样能显示');
  assert.equal(state.results[0].qualitySnapshot, 'auto');
  assert.equal(typeof state.results[0].startedAt, 'string');
  assert.equal(saves, 0, '读状态也不保存');
});

test('每张卡最多留 10 张：第 11 张画好时硬删最早的那张（文件和画廊记录一起），收藏的不删', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  const infos = [];
  const originalInfo = console.info;
  console.info = (...args) => infos.push(args.map(String).join(' '));
  t.after(() => { console.info = originalInfo; });
  const { client, release, deletedPaths } = await gatedClient(t, [message]);
  release();
  const attempts = [];
  for (let index = 0; index < 11; index += 1) attempts.push(await client.generate(generationInput(tagId, messageUuid)));
  assert.equal(infos.filter(line => /历史超过 10 张，已删除最早的 1 张/.test(line)).length, 1, '控制台说明删了哪张');
  const recordOf = () => client.tagRecord(tagId);
  const idsOf = () => recordOf().resultRefs.map(ref => ref.resultId);
  assert.equal(recordOf().resultRefs.length, 10);
  assert.deepEqual(deletedPaths.map(path => path.split('/').at(-1)), [`${attempts[0].resultIds[0]}.png`], '最早那张的文件删掉');
  assert.equal(idsOf().includes(attempts[0].resultIds[0]), false);
  assert.equal(recordOf().latestResultId, attempts[10].resultIds[0]);
  assert.equal((await client.galleryMetadata()).total, 10, '画廊记录一起删');

  await client.setFavorite(attempts[1].resultIds[0], true);
  await client.generate(generationInput(tagId, messageUuid));
  assert.equal(recordOf().resultRefs.length, 10);
  assert.equal(deletedPaths.length, 2);
  assert.match(deletedPaths[1], new RegExp(attempts[2].resultIds[0]), '收藏的那张不删，删它后面最早的');
  assert.ok(idsOf().includes(attempts[1].resultIds[0]), '收藏的留着');
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 10);
  assert.deepEqual(state.tag.resultIds, idsOf());
});

test('读状态时把旧版留在聊天里的生成记录搬进独立存储；聊天里那份原样不动、不保存', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const prompt = '提示词的复制品占了大头，'.repeat(60);
  const legacyAttempts = Array.from({ length: 40 }, (_, index) => ({
    attemptId: `legacy-${index}`,
    tagId,
    requestMode: 'manual',
    provider: 'openai',
    model: 'gpt-image-1',
    promptSnapshot: prompt,
    resolvedPrompt: `${prompt}, best quality`,
    artistPromptSnapshot: 'artist:'.repeat(50),
    status: index % 5 === 0 ? 'failed' : 'succeeded',
    errorMessage: index % 5 === 0 ? 'HTTP 500 '.repeat(80) : null,
    resultIds: [],
    createdAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 60_000).toISOString(),
    completedAt: new Date(Date.parse('2026-09-01T00:00:30.000Z') + index * 60_000).toISOString(),
  }));
  const message = {
    is_user: false,
    mes: `<draw>${prompt}</draw>`,
    extra: {
      stImageAtelier: {
        messageUuid,
        schemaVersion: 2,
        tags: [{
          tagId, prompt, ordinal: 0, count: 1, latestResultId: null,
          resultIds: [], attempts: legacyAttempts, results: [], autoAttempted: false, autoSuppressed: false,
        }],
      },
    },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = originalWarn; });
  let saves = 0;
  const { client, attemptStore } = await gatedClient(t, [message], { save: async () => { saves += 1; } });
  const before = byteLength(message.extra.stImageAtelier.tags);
  assert.ok(before > 20 * 1024, `旧数据 ${before} 字节`);

  const [state] = await client.resolveTags([tagId]);
  assert.equal(saves, 0, '读状态不保存聊天：旧格式原样留着，由「整理旧数据」一次换成引用');
  assert.equal(warnings.length, 0, '没有保存就没有「超过 20 KB」的警告');
  assert.equal(state.attempts.length, 20, '搬进去的时候就按每个标签 20 条的上限截断');
  assert.equal(state.attempts[0].attemptId, 'legacy-39', '最近的在前');
  assert.equal(state.attempts[0].promptSnapshot, prompt, '读出来的记录补回提示词');
  assert.equal('resolvedPrompt' in attemptStore.get('legacy-39'), false, '搬进独立存储的是精简过的');
  assert.ok(attemptStore.get('legacy-35').errorMessage.length <= 401);

  await attemptStore.flush();
  await flushMicrotasks();
  const tag = message.extra.stImageAtelier.tags[0];
  assert.equal(Array.isArray(tag.attempts), true, '聊天里那份旧记录原样留着，由「整理旧数据」一次清掉');
  assert.equal(saves, 0, '读状态不保存聊天');
  await client.resolveTags([tagId]);
  assert.equal(saves, 0, '再读也不保存');
  assert.equal((await client.resolveTags([tagId]))[0].attempts.length, 20);
});

test('「整理旧数据」：遍历所有楼层和滑动存档，搬走生成记录、补回画廊记录、状态进侧文件、楼里只留引用、超上限的旧图硬删，只保存一次，重复执行无副作用', async t => {
  const prompt = '一个很长的提示词模板，'.repeat(100);
  const artist = 'artist:someone, artist:another, '.repeat(40);
  const record = (resultId, tagId, extra = {}) => ({
    resultId,
    tagId,
    status: 'available',
    prompt,
    promptSnapshot: prompt,
    resolvedPrompt: artist + prompt,
    artistPromptSnapshot: artist,
    localRelativePath: `user/images/st-image-atelier/${resultId}.png`,
    createdAt: `2026-09-${String(10 + Number(resultId.split('-').at(-1))).padStart(2, '0')}T00:00:00.000Z`,
    ...extra,
  });
  const legacyAttempt = (tagId, index, resultIds = []) => ({
    attemptId: `${tagId}-attempt-${index}`,
    tagId,
    status: resultIds.length ? 'succeeded' : 'failed',
    promptSnapshot: prompt,
    resolvedPrompt: artist + prompt,
    artistPromptSnapshot: artist,
    artistNegativePromptSnapshot: artist,
    resultIds,
    createdAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1000).toISOString(),
  });
  const legacyTag = (tagId, resultIds, attemptCount) => ({
    tagId,
    prompt,
    ordinal: 0,
    count: 1,
    latestResultId: resultIds.at(-1) || null,
    resultIds,
    attempts: Array.from({ length: attemptCount }, (_, index) => legacyAttempt(tagId, index, index === 0 ? resultIds : [])),
    results: resultIds.map(resultId => record(resultId, tagId, resultId === 'D-1' ? { favorite: true } : {})),
    autoAttempted: true,
    autoSuppressed: false,
  });
  const aIds = ['A-1', 'A-2'];
  const dIds = Array.from({ length: 12 }, (_, index) => `D-${index + 1}`);
  const messageA = {
    is_user: false,
    mes: `<draw>${prompt}</draw>`,
    swipe_id: 0,
    swipes: [`<draw>${prompt}</draw>`, '另一版'],
    extra: { stImageAtelier: { messageUuid: 'mA', schemaVersion: 2, tags: [legacyTag('A', aIds, 30)] } },
  };
  messageA.swipe_info = [
    { extra: structuredClone(messageA.extra) },
    { extra: { stImageAtelier: { messageUuid: 'mA', schemaVersion: 2, tags: [legacyTag('B', ['B-1'], 5)] } } },
  ];
  const messageC = {
    is_user: false,
    mes: `<draw>${prompt}</draw>`,
    extra: {
      stImageAtelier: {
        messageUuid: 'mC',
        schemaVersion: 2,
        tags: [{
          tagId: 'C', prompt, ordinal: 0, count: 1, latestResultId: 'C-gone',
          resultRefs: [
            { resultId: 'C-1', path: 'user/images/st-image-atelier/C-1.png', createdAt: '2026-09-20T00:00:00.000Z' },
            { resultId: 'C-gone', path: 'user/images/st-image-atelier/C-gone.png', createdAt: '2026-09-21T00:00:00.000Z' },
          ],
          autoAttempted: true, autoSuppressed: false,
        }],
      },
    },
  };
  const messageD = {
    is_user: false,
    mes: `<draw>${prompt}</draw>`,
    extra: { stImageAtelier: { messageUuid: 'mD', schemaVersion: 2, tags: [legacyTag('D', dIds, 3)] } },
  };
  const chat = [{ is_user: true, mes: '你好' }, messageA, messageC, messageD];
  let saves = 0;
  const checked = [];
  const infos = [];
  const originalInfo = console.info;
  console.info = (...args) => infos.push(args.map(String).join(' '));
  t.after(() => { console.info = originalInfo; });
  const { client, attemptStore, galleryStore, deletedPaths, tagStores } = await gatedClient(t, chat, {
    save: async () => { saves += 1; },
    verifyFile: async path => { checked.push(path); return !path.includes('C-gone'); },
  });

  const plan = await client.organizeChat({ dryRun: true });
  assert.equal(plan.changed, false);
  assert.equal(saves, 0, '只算账不动数据');
  assert.equal(plan.messages, 4);
  assert.equal(plan.legacyFloors, 3, 'A、C、D 三楼还是旧格式');
  assert.equal(plan.containers, 5, 'A、A 的存档副本、B（另一版的存档）、C、D');
  assert.equal(plan.tags, 5);
  assert.equal(plan.legacyTags, 4);
  assert.equal(plan.movedAttempts, 30 + 5 + 3);
  assert.equal(plan.restoredResults, 0, '旧版整份图片记录在读聊天时就已经补回画廊（只写画廊文件，不动聊天）');
  assert.equal((await client.galleryMetadata()).total, 15);
  assert.equal(plan.danglingRefs, 2);
  assert.equal(plan.deletedImages, 2, 'D 有 12 张，超过上限 2 张（收藏的 D-1 不删）');
  assert.equal(attemptStore.size, 0);
  assert.equal(checked.length, 0);
  assert.equal(JSON.stringify(chat).includes('"tagIds"'), false, '算账不改聊天');

  const result = await client.organizeChat();
  assert.equal(result.changed, true);
  assert.equal(saves, 1, '整个聊天只保存一次');
  assert.ok(result.before.bytes > result.after.bytes * 20, `${result.before.bytes} → ${result.after.bytes}`);
  assert.equal(result.legacyFloors, 3);
  assert.equal(result.movedAttempts, 38);
  assert.equal(result.restoredResults, 1, '按路径核实的 C-1 补回画廊');
  assert.equal(result.droppedRefs, 1, 'C-gone 文件不在，引用去掉');
  assert.equal(result.deletedImages, 2);
  assert.deepEqual(checked.sort(), ['user/images/st-image-atelier/C-1.png', 'user/images/st-image-atelier/C-gone.png']);
  assert.deepEqual(deletedPaths.map(path => path.split('/').at(-1)).sort(), ['D-2.png', 'D-3.png'], '最早的、没收藏的两张硬删');
  assert.equal(infos.filter(line => /整理前：生图标签数据共 \d+ 字节/.test(line)).length, 1);
  assert.equal(infos.filter(line => /整理后：生图标签数据共 \d+ 字节/.test(line)).length, 1);

  /* 楼里只剩引用。 */
  assert.deepEqual(messageA.extra.stImageAtelier, { messageUuid: 'mA', tagIds: ['A'] });
  assert.deepEqual(messageA.swipe_info[0].extra.stImageAtelier, { messageUuid: 'mA', tagIds: ['A'] }, '当前版本的存档副本一样换成引用');
  assert.deepEqual(messageA.swipe_info[1].extra.stImageAtelier, { messageUuid: 'mA', tagIds: ['B'] }, '另一个滑动版本的存档也处理');
  assert.deepEqual(messageC.extra.stImageAtelier, { messageUuid: 'mC', tagIds: ['C'] });
  assert.deepEqual(messageD.extra.stImageAtelier, { messageUuid: 'mD', tagIds: ['D'] });
  for (const message of [messageA, messageC, messageD]) {
    assert.ok(byteLength(message.extra.stImageAtelier) < 120, `一楼的引用 ${byteLength(message.extra.stImageAtelier)} 字节`);
  }
  assert.doesNotMatch(JSON.stringify(chat.map(message => message.extra)), /一个很长的提示词模板/, '聊天的 extra 里没有提示词');

  /* 状态在侧文件里。 */
  const recordA = client.tagRecord('A');
  assert.deepEqual(recordA.resultRefs.map(ref => ref.resultId), aIds);
  assert.equal(recordA.resultRefs[0].path, 'user/images/st-image-atelier/A-1.png');
  assert.equal(recordA.latestResultId, 'A-2');
  assert.equal(recordA.autoAttempted, true);
  assert.deepEqual(client.tagRecord('B').resultRefs.map(ref => ref.resultId), ['B-1']);
  const recordC = client.tagRecord('C');
  assert.deepEqual(recordC.resultRefs.map(ref => ref.resultId), ['C-1']);
  assert.equal(recordC.latestResultId, 'C-1');
  assert.equal(galleryStore.document.results['C-1'].recovered, true, '文件还在的按引用补回画廊');
  const recordD = client.tagRecord('D');
  assert.equal(recordD.resultRefs.length, 10);
  assert.ok(recordD.resultRefs.some(ref => ref.resultId === 'D-1'), '收藏的留着');
  assert.equal(recordD.resultRefs.some(ref => ref.resultId === 'D-2'), false);
  assert.equal(recordD.latestResultId, 'D-12');
  const [tagStore] = [...tagStores.values()];
  assert.deepEqual(Object.keys(tagStore.document.tags).sort(), ['A', 'B', 'C', 'D'], '侧文件写好了');

  assert.equal(attemptStore.forTag('A').length, 20, '搬进去时按上限截断');
  assert.equal(attemptStore.forTag('B').length, 5);
  assert.equal('resolvedPrompt' in attemptStore.forTag('A')[0], false);
  assert.equal('promptSnapshot' in attemptStore.forTag('A')[0], false);
  assert.equal(Object.keys(galleryStore.document.results).length, 15 + 1 - 2);
  assert.equal(galleryStore.document.results['A-1'].prompt, prompt);
  assert.equal('resolvedPrompt' in galleryStore.document.results['A-1'], false, '画廊记录也只留一份提示词');

  const [stateA, stateC, stateD] = await client.resolveTags(['A', 'C', 'D']);
  assert.deepEqual(stateA.results.map(item => item.resultId), aIds, '整理后图照样能显示');
  assert.equal(stateA.attempts.length, 20);
  assert.equal(stateA.attempts[0].promptSnapshot, prompt, '提示词从正文里来');
  assert.equal(client.fileUrl('A-1'), '/user/images/st-image-atelier/A-1.png');
  assert.deepEqual(stateC.results.map(item => item.resultId), ['C-1']);
  assert.equal(stateD.results.length, 10);
  assert.equal(saves, 1, '读状态没有改动');

  const snapshot = JSON.stringify(chat);
  const writesBefore = tagStore.writes;
  const again = await client.organizeChat();
  assert.equal(again.changed, false, '再跑一次什么都不改');
  assert.equal(again.containers, 0);
  assert.equal(again.movedAttempts, 0);
  assert.equal(again.deletedImages, 0);
  assert.equal(saves, 1, '没改动就不保存');
  assert.equal(tagStore.writes, writesBefore, '侧文件也不写');
  assert.equal(JSON.stringify(chat), snapshot);
  assert.equal(again.before.bytes, again.after.bytes);
});

/* 1.7.1 白屏：出图返回、正文写完那一瞬间，酒馆自己要存聊天、要重画，插件再当场整份存一次、写两份文件，
   手机上就白屏。插件的保存并进酒馆的防抖（同一秒只写一次盘），文件写入延后合并，发请求前的防重复记录照样当拍落盘。 */
test('出图、读状态都不保存聊天；只有「整理旧数据」当场存一次', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const legacy = {
    is_user: false,
    mes: '<draw>legacy</draw>',
    extra: { stImageAtelier: { messageUuid: crypto.randomUUID(), tags: [{ tagId: 'legacy', prompt: 'legacy', results: [], resultIds: [], attempts: [] }] } },
  };
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  let immediate = 0;
  let soon = 0;
  const { client, release } = await gatedClient(t, [message, legacy], {
    save: async () => { immediate += 1; },
    saveSoon: async () => { soon += 1; },
  });
  release();
  await client.generate(generationInput(tagId, messageUuid));
  assert.equal(soon, 0, '出图不保存聊天：引用写进侧文件');
  assert.equal(immediate, 0);
  await client.resolveTags(['legacy']);
  assert.equal(soon, 0, '读状态也不保存：旧格式的楼原样留着');
  assert.equal(immediate, 0);
  await client.organizeChat();
  assert.equal(immediate, 1, '整理当场存一次，状态行说「已保存」就是真的');
  assert.equal(soon, 0);
});

test('发上游请求前防重复记录当拍落盘；画完的终态记录和画廊记录延后合并写，不耽误卡片更新', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  const attemptStore = createMemoryAttemptStore(null, { flushDelayMs: 60 });
  const galleryStore = createMemoryGalleryMetadataStore(null, { flushDelayMs: 60 });
  const { client, release, started } = await gatedClient(t, [message], { attemptStore, galleryStore });
  const pending = client.generate(generationInput(tagId, messageUuid));
  await started;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(attemptStore.writes, 1, '上游请求发出时记录已经在写进文件（不等 2 秒，也不等它写完）');
  assert.equal(attemptStore.get(generationInputId(pending)).status, 'generating');
  release();
  const attempt = await pending;
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attemptStore.writes, 1, '终态记录不当场写');
  assert.equal(galleryStore.writes, 0, '画廊记录也不当场写');
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 1, '内存里已经有记录，卡片照常显示');
  assert.equal(state.attempts[0].status, 'succeeded');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(attemptStore.writes, 2, '延后合并后写了一次');
  assert.equal(galleryStore.writes, 1);
  assert.equal(Object.keys(galleryStore.document.results).length, 1);
  assert.equal(attemptStore.document.attempts[attempt.attemptId].status, 'succeeded');
});

function generationInputId(pending) {
  return pending.__attemptId || lastAttemptId;
}
let lastAttemptId = '';
const originalGenerationInput = generationInput;
// eslint-disable-next-line no-func-assign
generationInput = (tagId, messageUuid) => {
  const input = originalGenerationInput(tagId, messageUuid);
  lastAttemptId = input.attemptId;
  return input;
};

test('上游返回的 base64 原样上传，不再整张解码再重新编码', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  const { client, release, uploads } = await gatedClient(t, [message]);
  release();
  const attempt = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(attempt.status, 'succeeded');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].image, PNG_BASE64, '上传的就是上游给的那串');
  assert.equal(uploads[0].format, 'png', '只解开头几十个字节就认出格式');
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results[0].byteSize, Buffer.from(PNG_BASE64, 'base64').length, '大小按 base64 长度算，和真解出来一样');
});

test('图片大小上限：没改过的老默认 30 MB 换成 64 MB，自己设的别的值不动；报错里写的是当前上限', async t => {
  const extensionSettings = { stImageAtelier: { settings: { maxImageBytes: 30 * 1024 * 1024 } } };
  const make = (settings = extensionSettings) => createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings: settings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  assert.equal((await make().getSettings()).maxImageBytes, 64 * 1024 * 1024, '老默认值换成新的');
  const custom = { stImageAtelier: { settings: { maxImageBytes: 8 * 1024 * 1024 } } };
  assert.equal((await make(custom).getSettings()).maxImageBytes, 8 * 1024 * 1024, '自己设的不动');

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  const { client, release } = await gatedClient(t, [message]);
  await client.updateSettings({ maxImageBytes: 1 });   // 测试用的 PNG 只有几十字节，上限设成 1 字节才会超
  release();
  await assert.rejects(client.generate(generationInput(tagId, messageUuid)), error => /图片超过 0 MB/.test(error.details) || /图片超过 0 MB/.test(error.message));
});

/* 1.8.0 参考图（图生图）。 */
test('参考图组：新建、每组最多 4 张、删掉时文件一起删、格式不对拒收；第一组自动成为默认组；预设上不再带参考图', async t => {
  const tagId = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, crypto.randomUUID()) } };
  const { client, deletedPaths, uploads } = await gatedClient(t, [message]);
  const png = Buffer.from(PNG_BASE64, 'base64');
  const empty = await client.getReferenceSets();
  assert.deepEqual(empty.sets, []);
  assert.equal(empty.defaultSetId, '');
  assert.equal(empty.activeSetId, '');

  let overview = await client.createReferenceSet({ name: '港哥' });
  const setId = overview.created.setId;
  assert.equal(overview.created.becameDefault, true, '第一组自动成为默认组');
  assert.equal(overview.defaultSetId, setId);
  assert.equal(overview.activeSetId, setId);
  for (let index = 0; index < 4; index += 1) {
    overview = await client.addReference(setId, { bytes: png, filename: `face-${index}.png` });
  }
  await assert.rejects(client.addReference(setId, { bytes: png, filename: 'one-more.png' }), /最多 4 张/);
  const set = overview.sets.find(item => item.id === setId);
  assert.equal(set.references.length, 4);
  assert.match(set.references[0].path, /^user\/images\/st-image-atelier-refs\/ref-/);
  assert.equal(set.references[0].name, 'face-0.png');
  assert.equal(uploads.filter(upload => upload.ch_name === 'st-image-atelier-refs').length, 4, '存在自己的目录');
  assert.equal(set.useReferences, true);
  assert.equal(set.referenceFidelity, '');
  const presets = await client.getPresets();
  assert.equal('references' in presets.items[0], false, '预设上不再带参考图');

  const removed = await client.removeReference(setId, set.references[0].id);
  assert.equal(removed.sets.find(item => item.id === setId).references.length, 3);
  assert.equal(deletedPaths.at(-1), set.references[0].path, '文件一起删');
  await assert.rejects(
    client.addReference(setId, { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), filename: 'bad.bin' }),
    /PNG、JPEG、WebP/,
  );
  await assert.rejects(client.removeReference(setId, 'missing'), /找不到这张参考图/);
  await assert.rejects(client.addReference('nope', { bytes: png, filename: 'x.png' }), /找不到这组参考图/);

  const renamed = await client.renameReferenceSet(setId, '港哥（新）');
  assert.equal(renamed.sets[0].name, '港哥（新）');
  const deleted = await client.deleteReferenceSet(setId);
  assert.deepEqual(deleted.sets, []);
  assert.equal(deleted.defaultSetId, '');
  assert.equal(deleted.activeSetId, '');
  assert.equal(deletedPaths.filter(path => path.includes('st-image-atelier-refs')).length, 4, '删组时剩下的 3 张文件也删了');
});

test('换一张参考图：原位替换顺序不变，满 4 张也能换；新图传好、写盘后才删旧文件；新图格式不对时原图不动', async t => {
  const tagId = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, crypto.randomUUID()) } };
  const { client, deletedPaths, uploads } = await gatedClient(t, [message]);
  const png = Buffer.from(PNG_BASE64, 'base64');
  const setId = (await client.createReferenceSet({ name: '组' })).created.setId;
  let overview;
  for (let index = 0; index < 4; index += 1) {
    overview = await client.addReference(setId, { bytes: png, filename: `face-${index}.png` });
  }
  const before = overview.sets[0].references;
  const uploadsBefore = uploads.length;
  const deletesBefore = deletedPaths.length;

  const replaced = (await client.replaceReference(setId, before[1].id, { bytes: png, filename: 'face-new.png' })).sets[0].references;
  assert.equal(replaced.length, 4, '满 4 张也能换，数量不变');
  assert.deepEqual(
    replaced.map(item => item.id).filter((_, index) => index !== 1),
    [before[0].id, before[2].id, before[3].id],
    '别的三张原样不动',
  );
  assert.notEqual(replaced[1].id, before[1].id);
  assert.equal(replaced[1].name, 'face-new.png', '新的那张顶在原来的位置');
  assert.notEqual(replaced[1].path, before[1].path);
  assert.equal(uploads.length, uploadsBefore + 1, '新图传上去');
  assert.deepEqual(deletedPaths.slice(deletesBefore), [before[1].path], '只删旧文件这一份');

  const persisted = (await client.getReferenceSets()).sets[0].references;
  assert.deepEqual(persisted.map(item => item.path), replaced.map(item => item.path));

  await assert.rejects(
    client.replaceReference(setId, replaced[0].id, { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), filename: 'bad.bin' }),
    /PNG、JPEG、WebP/,
  );
  assert.deepEqual((await client.getReferenceSets()).sets[0].references, persisted, '格式不对时原图原样留着');
  assert.equal(uploads.length, uploadsBefore + 1, '没有多传');
  assert.equal(deletedPaths.length, deletesBefore + 1, '没有多删');
  await assert.rejects(client.replaceReference(setId, 'missing', { bytes: png, filename: 'x.png' }), /找不到这张参考图/);
});

test('出图自动带上这个角色用的那组参考图：走 edits 接口、表单里有图、记录和画廊记录上记着路径；关掉自动带上就走普通接口', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  const { client, release, edits, served, requests } = await gatedClient(t, [message]);
  release();
  const png = Buffer.from(PNG_BASE64, 'base64');
  const setId = (await client.createReferenceSet({ name: '港哥' })).created.setId;
  await client.addReference(setId, { bytes: png, filename: 'face.png' });
  const paths = (await client.addReference(setId, { bytes: png, filename: 'outfit.png' })).sets[0].references.map(item => item.path);

  const attempt = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(attempt.status, 'succeeded');
  assert.equal(edits.length, 1, '走图生图接口');
  assert.equal(requests.length, 0, '没走普通生图接口');
  assert.equal(edits[0].body.getAll('image[]').length, 2);
  assert.equal(edits[0].body.get('prompt'), 'base64');
  assert.deepEqual(served.map(url => url.replace(/^\//, '')), paths, '参考图按顺序从酒馆读回来');
  assert.deepEqual(attempt.references, paths, '生成记录上记着参考图路径');
  const [state] = await client.resolveTags([tagId]);
  assert.deepEqual(state.results[0].references, paths, '画廊记录上也记着');
  assert.equal(state.attempts[0].references.length, 2);

  await client.updateReferenceSet(setId, { useReferences: false });
  const plain = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(plain.status, 'succeeded');
  assert.equal(requests.length, 1, '关掉自动带上就走普通接口');
  assert.equal('references' in plain, false);
  assert.equal(edits.length, 1);
});

test('「参考重画」：指定的那张排最前，再带这组的，最多 4 张；相册里临时选的用完就删', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  const { client, release, edits, served, deletedPaths } = await gatedClient(t, [message]);
  release();
  const png = Buffer.from(PNG_BASE64, 'base64');
  const setId = (await client.createReferenceSet({ name: '组' })).created.setId;
  let overview;
  for (let index = 0; index < 4; index += 1) overview = await client.addReference(setId, { bytes: png, filename: `ref-${index}.png` });
  const setPaths = overview.sets[0].references.map(item => item.path);

  const first = await client.generate(generationInput(tagId, messageUuid));
  const [state] = await client.resolveTags([tagId]);
  const shownPath = state.results[0].localRelativePath;
  served.length = 0;
  const again = await client.generate({ ...generationInput(tagId, messageUuid), references: [{ resultId: first.resultIds[0] }] });
  assert.equal(again.status, 'succeeded');
  assert.equal(edits.at(-1).body.getAll('image[]').length, 4, '最多 4 张');
  assert.deepEqual(again.references, [shownPath, ...setPaths.slice(0, 3)], '指定的那张排最前，这组的补满');
  assert.equal(served[0].replace(/^\//, ''), shownPath);

  const temp = await client.uploadReferenceImage({ bytes: png, filename: 'temp.png' });
  assert.match(temp.path, /st-image-atelier-refs\/ref-/);
  await client.updateReferenceSet(setId, { useReferences: false });
  const withTemp = await client.generate({ ...generationInput(tagId, messageUuid), references: [{ path: temp.path, temporary: true }] });
  assert.deepEqual(withTemp.references, [temp.path]);
  assert.ok(edits.at(-1).body.get('image') instanceof Blob, '一张用 image');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(deletedPaths.includes(temp.path), '临时参考图用完就删');
  assert.ok(setPaths.every(path => !deletedPaths.includes(path)), '组里的不动');
});

test('参考图组的增删换、建组都当场写盘，不只靠防抖：手机 Safari 后台重载也不丢', async t => {
  const tagId = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, crypto.randomUUID()) } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/${body.ch_name}/${body.filename}.${body.format}` });
    }
    if (url === '/api/images/delete') return response(200, {});
    throw new Error(`意外的请求：${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  let debounced = 0;
  let immediate = 0;
  const extensionSettings = {};
  const make = () => createDirectApiClient({
    compat: { chat: () => [message], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => { debounced += 1; },
    saveSettingsNow: async () => { immediate += 1; },
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const client = make();
  const presetId = (await client.getPresets()).activePresetId;
  const before = immediate;
  const setId = (await client.createReferenceSet({ name: '组' })).created.setId;
  assert.equal(immediate, before + 1, '建组当场写盘');
  const added = await client.addReference(setId, { bytes: Buffer.from(PNG_BASE64, 'base64'), filename: 'face.png' });
  assert.equal(immediate, before + 2, '加参考图当场写盘');
  const replaced = await client.replaceReference(setId, added.sets[0].references[0].id, { bytes: Buffer.from(PNG_BASE64, 'base64'), filename: 'face-2.png' });
  assert.equal(immediate, before + 3, '换一张也当场写盘');
  await client.removeReference(setId, replaced.sets[0].references[0].id);
  assert.equal(immediate, before + 4, '删参考图也当场写盘');
  await client.updatePreset(presetId, { name: '改个名' });
  assert.equal(immediate, before + 4, '普通改动照旧防抖');
  assert.ok(debounced >= 1);

  const reloaded = make();
  const again = await reloaded.getReferenceSets();
  assert.equal(again.sets.length, 1);
  assert.deepEqual(again.sets[0].references, [], '写进 extension_settings 的就是内存里那份');
  assert.equal(again.defaultSetId, setId);
});

test('迁移：老版本每个预设上的参考图各成一组，一样的几张只留一组，当前预设那组是默认组；预设上不再带参考图', async () => {
  const refs = (...names) => names.map(name => ({ id: name, path: `user/images/st-image-atelier-refs/${name}.png`, name: `${name}.png`, addedAt: '' }));
  const extensionSettings = {
    stImageAtelier: {
      activePresetId: 'b',
      presets: [
        { id: 'a', name: '主站', references: refs('face', 'outfit'), useReferences: true, referenceFidelity: 'high' },
        { id: 'b', name: '港', references: refs('face', 'outfit'), useReferences: false },
        { id: 'c', name: '备用', references: refs('other') },
        { id: 'd', name: '没图' },
      ],
    },
  };
  const client = createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const overview = await client.getReferenceSets();
  assert.deepEqual(
    overview.sets.map(set => [set.name, set.references.map(item => item.name), set.useReferences, set.referenceFidelity]),
    [
      ['主站', ['face.png', 'outfit.png'], true, 'high'],
      ['备用', ['other.png'], true, ''],
    ],
    '一样的几张只留一组（组名用先出现的预设名），不同的各成一组',
  );
  assert.equal(overview.defaultSetId, overview.sets[0].id, '当前预设「港」和「主站」是同一组，它是默认组');
  assert.equal(overview.activeSetId, overview.sets[0].id);
  for (const preset of (await client.getPresets()).items) {
    assert.equal('references' in preset, false, `${preset.name} 不再带 references`);
    assert.equal('useReferences' in preset, false);
    assert.equal('referenceFidelity' in preset, false);
  }
  assert.ok(extensionSettings.stImageAtelier.presets.every(preset => !('references' in preset)), '写回设置的预设也不带');
  assert.equal(extensionSettings.stImageAtelier.referenceSets.length, 2);
  const again = createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  assert.equal((await again.getReferenceSets()).sets.length, 2, '再加载不会重复迁移');
});

test('角色卡绑定：每个角色记住自己用哪组，没设置的用默认组，设成「不带」就不带；删掉绑定的组退回默认；高保真跟着组走', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  let character = { key: 'char:a.png', name: '阿A' };
  const { client, release, edits, requests } = await gatedClient(t, [message], {
    compatExtra: { currentCharacterKey: () => character.key, currentCharacterName: () => character.name },
  });
  release();
  const png = Buffer.from(PNG_BASE64, 'base64');

  let overview = await client.createReferenceSet({ name: '阿A的脸' });
  const setA = overview.created.setId;
  assert.equal(overview.created.becameDefault, true);
  assert.equal(overview.created.boundCharacter, false, '第一组就是默认组，不用单独绑');
  assert.equal(overview.character.name, '阿A');
  await client.addReference(setA, { bytes: png, filename: 'a.png' });
  await client.updateReferenceSet(setA, { referenceFidelity: 'high' });

  character = { key: 'char:b.png', name: '小B' };
  overview = await client.createReferenceSet({ name: '小B的脸' });
  const setB = overview.created.setId;
  assert.equal(overview.created.boundCharacter, true, '打开着别的角色卡建新组，这个角色直接用新组');
  assert.equal(overview.character.setId, setB);
  assert.equal(overview.character.follows, false);
  assert.equal(overview.activeSetId, setB);
  assert.equal(overview.defaultSetId, setA, '默认组还是第一组');
  await client.addReference(setB, { bytes: png, filename: 'b1.png' });
  await client.addReference(setB, { bytes: png, filename: 'b2.png' });

  let attempt = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(edits.length, 1, '小B 出图带参考图');
  assert.equal(edits[0].body.getAll('image[]').length, 2, '带的是小B那组的 2 张');
  assert.equal(edits[0].body.get('input_fidelity'), null, '小B那组没开高保真');
  assert.equal(attempt.references.length, 2);

  character = { key: 'char:a.png', name: '阿A' };
  attempt = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(edits.length, 2);
  assert.ok(edits[1].body.get('image') instanceof Blob, '阿A 跟默认组，1 张用 image');
  assert.equal(edits[1].body.get('input_fidelity'), 'high', '高保真跟着组走');

  overview = await client.bindReferenceSet('');
  assert.equal(overview.character.setId, '');
  assert.equal(overview.activeSetId, '');
  attempt = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(requests.length, 1, '设成不带参考图就走普通接口');
  assert.equal('references' in attempt, false);

  overview = await client.bindReferenceSet(null);
  assert.equal(overview.character.follows, true);
  assert.equal(overview.activeSetId, setA);

  await client.deleteReferenceSet(setB);
  character = { key: 'char:b.png', name: '小B' };
  overview = await client.getReferenceSets();
  assert.equal(overview.character.follows, true, '绑定的组删了就退回跟默认');
  assert.equal(overview.activeSetId, setA);

  character = { key: '', name: '' };
  await assert.rejects(client.bindReferenceSet(setA), /没有打开角色卡/);
  overview = await client.getReferenceSets();
  assert.equal(overview.activeSetId, setA, '没开角色卡也按默认组出');
  assert.equal(overview.character.key, '');
});

test('画廊缩略图：出图后在后台生成，原图不动；格子用缩略图、看图用原图；已有的不重做；删图连带删缩略图', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  const thumbnailCalls = [];
  const thumbnailer = async blob => {
    thumbnailCalls.push(blob.size);
    return { blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }), width: 32, height: 56 };
  };
  const { client, release, uploads, served, deletedPaths } = await gatedClient(t, [message], { thumbnailer });
  release();
  const attempt = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(attempt.status, 'succeeded');
  const resultId = attempt.resultIds[0];
  const original = client.fileUrl(resultId);
  assert.match(original, /^\/user\/images\/st-image-atelier\//);
  assert.equal(client.thumbnailUrl(resultId), original, '缩略图还没做好之前格子用原图');

  await client.thumbnailsSettled();
  assert.equal(thumbnailCalls.length, 1, '做了一张');
  assert.ok(served.includes(original), '从酒馆读回原图来缩');
  const thumbUpload = uploads.find(upload => upload.ch_name === 'st-image-atelier-thumbs');
  assert.ok(thumbUpload, '缩略图存在自己的目录');
  assert.equal(thumbUpload.filename, `${resultId}-thumb`);
  assert.equal(thumbUpload.format, 'jpeg');
  assert.equal(uploads.filter(upload => upload.ch_name === 'st-image-atelier').length, 1, '原图只传了一次，没有被改写');
  assert.equal(client.fileUrl(resultId), original, '原图路径不变');
  assert.equal(client.downloadUrl(resultId), original, '下载也是原图');
  assert.equal(client.thumbnailUrl(resultId), `/user/images/st-image-atelier-thumbs/${resultId}-thumb.jpeg`);
  assert.equal(client.hasThumbnail(resultId), true);

  const record = (await client.galleryMetadata()).items.find(item => item.resultId === resultId);
  assert.equal(record.localRelativePath, original.replace(/^\//, ''));
  assert.equal(record.thumbnailPath, `user/images/st-image-atelier-thumbs/${resultId}-thumb.jpeg`);
  assert.equal(record.thumbnailWidth, 32);
  assert.equal(record.thumbnailHeight, 56);
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results[0].thumbnailPath, record.thumbnailPath, '卡片那边读到的记录也带着');

  assert.equal(await client.ensureThumbnail(resultId), record.thumbnailPath, '已有的直接给，不重做');
  assert.equal(thumbnailCalls.length, 1);

  await client.deleteResult(resultId);
  assert.ok(deletedPaths.includes(record.localRelativePath), '原图删了');
  assert.ok(deletedPaths.includes(record.thumbnailPath), '缩略图跟着删');
});

test('补全画廊缩略图：只补没有的、最新的先、一次一张、可中止；同一张并发只做一次；没有缩略图的退回原图', async t => {
  const tagId = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, crypto.randomUUID()) } };
  const old = ['a', 'b', 'c'].map((suffix, index) => ({
    resultId: `old-${suffix}`,
    tagId,
    status: 'available',
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    localRelativePath: `user/images/st-image-atelier/old-${suffix}.png`,
    prompt: 'p',
    provider: 'openai',
    presetId: 'main',
    favorite: false,
  }));
  const galleryStore = createMemoryGalleryMetadataStore({
    schemaVersion: 1,
    results: Object.fromEntries(old.map(record => [record.resultId, record])),
    updatedAt: '2026-01-04T00:00:00.000Z',
  });
  let made = 0;
  const thumbnailer = async () => {
    made += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), width: 8, height: 8 };
  };
  const { client, uploads } = await gatedClient(t, [message], { thumbnailer, galleryStore });
  assert.equal(client.thumbnailUrl('old-a'), '/user/images/st-image-atelier/old-a.png', '没有缩略图就退回原图');
  assert.equal(client.hasThumbnail('old-a'), false);

  const progress = [];
  const controller = new AbortController();
  const summary = await client.backfillThumbnails({
    signal: controller.signal,
    onProgress: value => {
      progress.push(value.resultId);
      if (progress.length === 2) controller.abort();
    },
  });
  assert.deepEqual(progress, ['old-c', 'old-b'], '最新的先补，中止后不再继续');
  assert.deepEqual(summary, { total: 3, done: 2, failed: 0, aborted: true });
  assert.equal(made, 2);
  assert.equal(client.thumbnailUrl('old-c'), '/user/images/st-image-atelier-thumbs/old-c-thumb.jpeg');
  assert.equal(client.thumbnailUrl('old-a'), '/user/images/st-image-atelier/old-a.png', '没补到的还是原图');

  const [first, second] = await Promise.all([client.ensureThumbnail('old-a'), client.ensureThumbnail('old-a')]);
  assert.equal(first, second);
  assert.equal(made, 3, '同一张并发只做一次');

  const again = await client.backfillThumbnails();
  assert.deepEqual(again, { total: 0, done: 0, failed: 0, aborted: false }, '都有了就没事可做');
  assert.equal(uploads.filter(upload => upload.ch_name === 'st-image-atelier-thumbs').length, 3);
  assert.equal(uploads.filter(upload => upload.ch_name === 'st-image-atelier').length, 0, '原图一张没动');
});

/* 2.0.0 幂等：聊天放着不动、刷新、切回来，聊天和侧文件都不该再写。小锚十分钟里不该冒出新快照。 */
test('引用格式的聊天：重新识别、重新加载、切回来都不写聊天也不写侧文件', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const prompt = '夜色里的码头，'.repeat(50);
  const document = {
    schemaVersion: 1,
    chatId: 'chat-1',
    characterKey: 'char:a.png',
    tags: {
      [tagId]: {
        promptHash: (await import('../../src/ui/api/chat-tag-store.js')).promptHash(prompt),
        latestResultId: null,
        resultRefs: [],
        autoAttempted: true,
        autoSuppressed: false,
      },
    },
  };
  const chat = [
    { is_user: true, mes: '你好' },
    { is_user: false, mes: `正文 <draw>${prompt}</draw>`, extra: { stImageAtelier: { messageUuid, tagIds: [tagId] } } },
  ];
  const snapshot = JSON.stringify(chat);
  const stores = [];
  const open = () => gatedClient(t, chat, {
    save: async () => { throw new Error('不该保存聊天'); },
    saveSoon: async () => { throw new Error('不该保存聊天'); },
    compatExtra: { currentChatId: () => 'chat-1', currentCharacterKey: () => 'char:a.png' },
    chatTagStore: () => { const store = createMemoryChatTagStore(document, { chatId: 'chat-1', characterKey: 'char:a.png' }); stores.push(store); return store; },
  });

  const first = await open();
  for (let round = 0; round < 3; round += 1) {
    const result = await first.client.reconcileMessage(1);
    assert.equal(result.changed, false, '一样的引用不算改动');
    assert.equal(result.tags[0].tagId, tagId);
    assert.equal(result.tags[0].prompt, prompt, '提示词从正文里来');
    const [state] = await first.client.resolveTags([tagId]);
    assert.equal(state.tag.autoAttempted, true);
  }
  assert.equal(stores[0].writes, 0, '侧文件一次都没写');
  assert.equal(JSON.stringify(chat), snapshot, '聊天一个字没动');

  /* 刷新页面 = 新的客户端、同一份侧文件。 */
  const second = await open();
  await second.client.reconcileMessage(1);
  await second.client.resolveTags([tagId]);
  assert.equal(stores[1].writes, 0, '重新加载也不写');
  assert.equal(JSON.stringify(chat), snapshot);
  assert.equal(second.client.chatTagFile(), first.client.chatTagFile());
  assert.match(second.client.chatTagFile(), /^st-image-atelier-chat-chat-1-[0-9a-z]+\.json$/);
});

test('旧格式的楼：读聊天时状态搬进侧文件（只写一次），聊天不动；刷新再读不再写；标签改了才升级成引用', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: leanMetadata(tagId, messageUuid) } };
  message.extra.stImageAtelier.tags[0].autoAttempted = true;
  const snapshot = JSON.stringify(message);
  let saves = 0;
  const shared = createMemoryChatTagStore(null, { chatId: 'c', characterKey: 'k' });
  const options = () => ({
    save: async () => { saves += 1; },
    saveSoon: async () => { saves += 1; },
    compatExtra: { currentChatId: () => 'c', currentCharacterKey: () => 'k' },
    chatTagStore: () => shared,
  });

  const first = await gatedClient(t, [message], options());
  const result = await first.client.reconcileMessage(0);
  assert.equal(result.changed, false, '旧格式的楼不动');
  assert.deepEqual(result.tags.map(tag => [tag.tagId, tag.autoAttempted]), [[tagId, true]], '状态从楼里带出来');
  await first.client.resolveTags([tagId]);
  await shared.flush();
  assert.equal(shared.writes, 1, '搬进侧文件写一次');
  assert.deepEqual(Object.keys(shared.document.tags), [tagId]);
  assert.equal(JSON.stringify(message), snapshot, '聊天一个字没动');
  assert.equal(saves, 0);

  /* 刷新：同一份侧文件再读，不写。 */
  const reopened = createMemoryChatTagStore(shared.document, { chatId: 'c', characterKey: 'k' });
  const second = await gatedClient(t, [message], { ...options(), chatTagStore: () => reopened });
  await second.client.reconcileMessage(0);
  await second.client.resolveTags([tagId]);
  await reopened.flush();
  assert.equal(reopened.writes, 0, '重新加载不写侧文件');
  assert.equal(JSON.stringify(message), snapshot);
  assert.equal(saves, 0);

  /* 正文里的标签变了：这楼升级成引用，新标签拿新 ID，旧 ID 的记录还在。 */
  message.mes = '<draw>base64</draw> <draw>another</draw>';
  const edited = await second.client.reconcileMessage(0);
  assert.equal(edited.changed, true);
  assert.deepEqual(Object.keys(message.extra.stImageAtelier), ['messageUuid', 'tagIds']);
  assert.equal(message.extra.stImageAtelier.messageUuid, messageUuid, 'messageUuid 沿用');
  assert.equal(message.extra.stImageAtelier.tagIds[0], tagId, '没变的标签 ID 不变');
  assert.equal(message.extra.stImageAtelier.tagIds.length, 2);
  await reopened.flush();
  assert.equal(reopened.writes, 1, '新标签的记录写进侧文件');
});

test('侧文件按聊天分：换聊天换文件、记录不串；切回来照样找得到', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const chats = {
    a: [{ is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: { messageUuid, tagIds: [tagId] } } }],
    b: [{ is_user: false, mes: '别的聊天' }],
  };
  let current = 'a';
  const { client, release, tagStores } = await gatedClient(t, chats.a, {
    compatExtra: { currentChatId: () => `chat-${current}`, currentCharacterKey: () => 'char:a.png' },
  });
  release();
  const attempt = await client.generate(generationInput(tagId, messageUuid));
  assert.equal(attempt.status, 'succeeded');
  const fileA = client.chatTagFile();
  assert.deepEqual(client.tagRecord(tagId).resultRefs.map(ref => ref.resultId), attempt.resultIds);

  current = 'b';
  await client.ensureTagStore();
  const fileB = client.chatTagFile();
  assert.notEqual(fileA, fileB, '另一个聊天另一个文件');
  assert.equal(client.tagRecord(tagId), null, '别的聊天里没有这条记录');

  current = 'a';
  assert.equal(client.chatTagFile(), fileA);
  assert.deepEqual(client.tagRecord(tagId).resultRefs.map(ref => ref.resultId), attempt.resultIds, '切回来照样在');
  assert.equal(tagStores.size, 2);
});

/* 2.0.1：侧文件写不进去（酒馆 400 拒掉文件名、网络抖）不能拦着出图——防重复靠的是独立存储那条当拍落盘的记录。 */
test('侧文件写失败：自动生图照样发请求、出图，记录留在内存里；弹窗的原因带着真正的细节', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = { is_user: false, mes: '<draw>base64</draw>', extra: { stImageAtelier: { messageUuid, tagIds: [tagId] } } };
  let writeAttempts = 0;
  const { client, release, requests } = await gatedClient(t, [message], {
    compatExtra: { currentChatId: () => '钟由时 - 2026-11-01@20h59m56s197ms', currentCharacterKey: () => 'char:a.png' },
    chatTagStore: identity => createChatTagStore({
      ...identity,
      readDocument: async () => null,
      writeDocument: async () => { writeAttempts += 1; throw new Error("Illegal character in filename; only alphanumeric, '_', '-' are accepted."); },
    }),
  });
  release();
  const attempt = await client.generate({ ...generationInput(tagId, messageUuid), attemptId: `auto:${tagId}`, requestMode: 'auto' });
  assert.equal(attempt.status, 'succeeded', '侧文件写不进去也照样出图');
  assert.equal(requests.length, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(writeAttempts >= 1, '写是试过的');
  const record = client.tagRecord(tagId);
  assert.equal(record.autoAttempted, true, '标记留在内存里');
  assert.deepEqual(record.resultRefs.map(ref => ref.resultId), attempt.resultIds);
  assert.match(client.chatTagFile(), /^st-image-atelier-chat-2026-11-01_20h59m56s197ms-[0-9a-z]+\.json$/, '文件名只剩酒馆收的字符');
});
