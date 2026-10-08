import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { createMemoryGalleryMetadataStore } from '../../src/ui/api/gallery-metadata-store.js';
import { createMemoryAttemptStore } from '../../src/ui/api/attempt-store.js';
import { PNG_BASE64, startMockUpstream } from '../mocks/mock-upstream.js';
import { byteLength } from '../../src/ui/state/tag-footprint.js';

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
  const attempt = await client.generate(input);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.resultIds.length, 1);
  assert.equal(uploads.size, 1);
  assert.equal(chatSaves, 1, '出图后聊天只保存这一次：生成记录不再逐步写进聊天');
  assert.ok(settingsSaves >= 3);
  const storedTag = message.extra.stImageAtelier.tags[0];
  assert.equal(storedTag.attempts, undefined, '生成记录不留在聊天里');
  assert.deepEqual(storedTag.resultRefs.map(ref => ref.resultId), attempt.resultIds, '聊天里只留图片引用');
  assert.match(storedTag.resultRefs[0].path, /^user\/images\/st-image-atelier\//);

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
  assert.equal(chatSaves, 2, '删除图片时保存一次');
  assert.equal((await client.gallery()).items.length, 0);
  assert.equal((await client.resolveTags([tagId]))[0].tag.autoSuppressed, true);
  assert.deepEqual(message.extra.stImageAtelier.tags[0].resultRefs, [], '引用一起删掉，不留墓碑');

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
  let resolving = false;
  const compat = {
    chat: () => [message],
    save: async () => {
      message.extra.stImageAtelier = structuredClone(message.extra.stImageAtelier);
      if (!client || resolving) return;
      resolving = true;
      try {
        const [state] = await client.resolveTags([tagId]);
        observedStatuses.push(state.attempts[0]?.status || 'none');
      } finally {
        resolving = false;
      }
    },
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

  const attempt = await client.generate({
    tagId,
    attemptId: `auto:${tagId}`,
    requestMode: 'auto',
    prompt: 'base64',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1, ratio: 'square' },
  });
  const [state] = await client.resolveTags([tagId]);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(state.attempts[0].status, 'succeeded');
  assert.equal(state.results.length, 1);
  assert.equal(observedStatuses.includes('interrupted'), false);
  assert.equal(observedStatuses.includes('queued'), false);
  assert.equal(observedStatuses.includes('generating'), true);
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
  assert.equal(chatSaves, 1);
  assert.equal(settingsSaves, 1);
  assert.equal(tag.autoSuppressed, true);
  assert.deepEqual(tag.resultRefs.map(ref => ref.resultId), values.slice(2).map(item => item.resultId));
  assert.equal('resultIds' in tag, false, '改写时顺手换成精简形');
  assert.equal(tag.latestResultId, values.at(-1).resultId);
  assert.deepEqual((await client.gallery()).items.map(item => item.resultId), [
    values[3].resultId,
    values[2].resultId,
  ]);
  assert.equal((await client.resolveTags([tagId]))[0].results.length, 2);
  assert.equal('results' in tag, false);
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
    'novelAi',
    'presets',
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
  assert.equal('results' in tag, false);
  assert.deepEqual(tag.resultIds, []);
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
  assert.equal(tag.results, undefined, '聊天里的整份记录清掉');
  assert.deepEqual(tag.resultIds, ['orphan-1'], '可用记录保留在 resultIds 里');
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].prompt, 'orphan prompt');
  assert.equal(client.fileUrl('orphan-1'), '/user/images/st-image-atelier/orphan-1.png');
  await galleryStore.flush();
  assert.equal(Object.keys(galleryStore.document.results).length, 1, '补回了索引文件');
  assert.equal(chatSaves, 1);
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
} = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const deletedPaths = [];
  const uploads = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      uploads.push(body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
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
    },
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    galleryStore,
    attemptStore,
    verifyFile,
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
  return { client, requests, release, started, deletedPaths, uploads, attemptStore, galleryStore };
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

  release();
  const attempt = await pending;
  assert.equal(attempt.status, 'succeeded');
  const archived = message.swipe_info[0].extra.stImageAtelier.tags[0];
  assert.deepEqual(archived.attempts ?? [], [], '生成记录不写进聊天，在独立存储里');
  assert.deepEqual(archived.resultRefs.map(ref => ref.resultId), attempt.resultIds, '上一版的存档里记着图片引用');
  assert.equal(archived.latestResultId, attempt.resultIds[0]);
  assert.deepEqual(message.extra.stImageAtelier.tags[0].resultIds, [], '新的一版不受影响');

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
  assert.deepEqual(
    savedWhileGenerating.stImageAtelier.tags[0].resultRefs.map(ref => ref.resultId),
    attempt.resultIds,
    '接回来的引用写进聊天',
  );
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

test('读卡片状态时要等聊天保存，这期间图画好了：读回来的是保存完的最新状态，不是开始读时的旧快照', async t => {
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
  const pending = client.generate(generationInput(tagId, messageUuid));
  await started;

  message.extra.stImageAtelier.tags[0].results = [];
  holdSaves = true;
  const reading = client.resolveTags([tagId]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(held.length, 1, '读状态时清掉旧字段，正在等保存');
  holdSaves = false;

  release();
  const attempt = await pending;
  assert.equal(attempt.status, 'succeeded');
  held.splice(0).forEach(resolve => resolve());
  const [state] = await reading;
  assert.equal(state.attempts[0].status, 'succeeded', '不能把开始读时的「生成中」送回卡片');
  assert.deepEqual(state.results.map(result => result.resultId), attempt.resultIds);
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
test('出图后聊天里只留轻量引用：没有生成记录和提示词复制品，除提示词外不到 2 KB；记录在独立存储里', async t => {
  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const prompt = '雨夜霓虹街道中的电影感人像，长发女子撑着透明伞，'.repeat(120);
  const message = { is_user: false, mes: `<draw>${prompt}</draw>`, extra: { stImageAtelier: leanMetadata(tagId, messageUuid, prompt) } };
  let saves = 0;
  const { client, release, attemptStore } = await gatedClient(t, [message], { save: async () => { saves += 1; } });
  release();
  for (let index = 0; index < 3; index += 1) {
    await client.generate({ ...generationInput(tagId, messageUuid), prompt });
  }
  const tag = message.extra.stImageAtelier.tags[0];
  assert.equal(saves, 3, '每次出图只保存一次聊天，进度不再逐步写进聊天');
  assert.equal('attempts' in tag, false, '生成记录不进聊天');
  assert.equal(tag.resultRefs.length, 3);
  assert.deepEqual(Object.keys(tag.resultRefs[0]), ['resultId', 'path', 'createdAt'], '每张图只记 id、路径、时间');
  const { prompt: storedPrompt, ...rest } = tag;
  assert.equal(storedPrompt, prompt, '提示词只存这一份');
  assert.ok(byteLength(rest) < 2048, `除提示词外 ${byteLength(rest)} 字节，要在 2 KB 以内`);
  assert.doesNotMatch(JSON.stringify(rest), /雨夜霓虹/, '聊天里没有第二份提示词');

  const stored = attemptStore.forTag(tagId);
  assert.equal(stored.length, 3);
  assert.equal(stored[0].status, 'succeeded');
  assert.equal('promptSnapshot' in stored[0], false, '和标签一样的提示词不再存一份');
  assert.equal('artistPromptSnapshot' in stored[0], false);
  assert.equal('resolvedPrompt' in stored[0], false);
  assert.ok(byteLength(stored[0]) < 1024, `一条生成记录 ${byteLength(stored[0])} 字节`);
  assert.ok(attemptStore.writes >= 3, '记录真的写进了独立文件');

  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.attempts[0].promptSnapshot, prompt, '读出来补回标签的提示词');
  assert.equal(state.results.length, 3);
  assert.equal(state.results[0].requestedSize, '1024x1024', '画质、尺寸、开始时间记在画廊记录里，生成记录清掉后卡片照样能显示');
  assert.equal(state.results[0].qualitySnapshot, 'auto');
  assert.equal(typeof state.results[0].startedAt, 'string');
  assert.equal(saves, 3, '读状态没有改动就不保存');
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
  const tag = message.extra.stImageAtelier.tags[0];
  const idsOf = () => tag.resultRefs.map(ref => ref.resultId);
  assert.equal(tag.resultRefs.length, 10);
  assert.deepEqual(deletedPaths.map(path => path.split('/').at(-1)), [`${attempts[0].resultIds[0]}.png`], '最早那张的文件删掉');
  assert.equal(idsOf().includes(attempts[0].resultIds[0]), false);
  assert.equal(tag.latestResultId, attempts[10].resultIds[0]);
  assert.equal((await client.galleryMetadata()).total, 10, '画廊记录一起删');

  await client.setFavorite(attempts[1].resultIds[0], true);
  await client.generate(generationInput(tagId, messageUuid));
  assert.equal(tag.resultRefs.length, 10);
  assert.equal(deletedPaths.length, 2);
  assert.match(deletedPaths[1], new RegExp(attempts[2].resultIds[0]), '收藏的那张不删，删它后面最早的');
  assert.ok(idsOf().includes(attempts[1].resultIds[0]), '收藏的留着');
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 10);
  assert.deepEqual(state.tag.resultIds, idsOf());
});

test('读状态时把旧版留在聊天里的生成记录搬进独立存储，写进文件后才从聊天里删掉；保存前超过 20 KB 会警告', async t => {
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
  assert.equal(saves, 1, '清掉旧版的 results 字段时保存一次（和以前一样）');
  assert.equal(warnings.length, 1, '保存前检查到这一楼超过 20 KB');
  assert.match(warnings[0][0], /第 0 楼的生图标签数据有 .* KB，超过 20\.0 KB/);
  assert.equal(warnings[0][1][0].标签, tagId);
  assert.match(warnings[0][1][0].字段.attempts, /KB$/);
  assert.equal(state.attempts.length, 20, '搬进去的时候就按每个标签 20 条的上限截断');
  assert.equal(state.attempts[0].attemptId, 'legacy-39', '最近的在前');
  assert.equal(state.attempts[0].promptSnapshot, prompt, '读出来的记录补回提示词');
  assert.equal('resolvedPrompt' in attemptStore.get('legacy-39'), false, '搬进独立存储的是精简过的');
  assert.ok(attemptStore.get('legacy-35').errorMessage.length <= 401);

  await attemptStore.flush();
  await flushMicrotasks();
  const tag = message.extra.stImageAtelier.tags[0];
  assert.equal('attempts' in tag, false, '写进文件之后聊天里的旧记录删掉');
  assert.deepEqual(Object.keys(tag), ['tagId', 'prompt', 'ordinal', 'count', 'latestResultId', 'resultIds', 'autoAttempted', 'autoSuppressed'], '字段顺序和识别时一致');
  assert.equal(saves, 1, '删掉不单独保存聊天，酒馆下次保存时带上');
  assert.ok(byteLength(tag) - byteLength(prompt) < 2048, '除提示词外不到 2 KB');
  await client.resolveTags([tagId]);
  assert.equal(saves, 1, '再读不再保存');
  assert.equal((await client.resolveTags([tagId]))[0].attempts.length, 20);
});

test('「瘦身当前聊天」：遍历所有楼层和滑动存档，搬走生成记录、补回画廊记录、只留引用、超上限的旧图硬删，保存一次，重复执行无副作用', async t => {
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
  const { client, attemptStore, galleryStore, deletedPaths } = await gatedClient(t, chat, {
    save: async () => { saves += 1; },
    verifyFile: async path => { checked.push(path); return !path.includes('C-gone'); },
  });

  const plan = await client.slimChat({ dryRun: true });
  assert.equal(plan.changed, false);
  assert.equal(saves, 0, '只算账不动数据');
  assert.equal(plan.messages, 4);
  assert.equal(plan.tags, 5, 'A、A 的存档副本、B、C、D');
  assert.equal(plan.legacyTags, 4);
  assert.equal(plan.movedAttempts, 30 + 5 + 3);
  assert.equal(plan.restoredResults, 2 + 1 + 12);
  assert.equal(plan.danglingRefs, 2);
  assert.equal(plan.deletedImages, 2, 'D 有 12 张，超过上限 2 张（收藏的 D-1 不删）');
  assert.equal(attemptStore.size, 0);
  assert.equal(checked.length, 0);

  const result = await client.slimChat();
  assert.equal(result.changed, true);
  assert.equal(saves, 1, '整个聊天只保存一次');
  assert.ok(result.before.bytes > result.after.bytes * 20, `${result.before.bytes} → ${result.after.bytes}`);
  assert.equal(result.movedAttempts, 38);
  assert.equal(result.restoredResults, 15 + 1, '旧版整份记录 15 张补回画廊，加上按路径核实的 C-1');
  assert.equal(result.droppedRefs, 1, 'C-gone 文件不在，引用去掉');
  assert.equal(result.deletedImages, 2);
  assert.deepEqual(checked.sort(), ['user/images/st-image-atelier/C-1.png', 'user/images/st-image-atelier/C-gone.png']);
  assert.deepEqual(deletedPaths.map(path => path.split('/').at(-1)).sort(), ['D-2.png', 'D-3.png'], '最早的、没收藏的两张硬删');
  assert.equal(infos.filter(line => /瘦身前：生图标签数据共 \d+ 字节/.test(line)).length, 1);
  assert.equal(infos.filter(line => /瘦身后：生图标签数据共 \d+ 字节/.test(line)).length, 1);

  const tagA = messageA.extra.stImageAtelier.tags[0];
  assert.deepEqual(Object.keys(tagA), ['tagId', 'prompt', 'ordinal', 'count', 'latestResultId', 'resultRefs', 'autoAttempted', 'autoSuppressed']);
  assert.deepEqual(tagA.resultRefs.map(ref => ref.resultId), aIds);
  assert.equal(tagA.resultRefs[0].path, 'user/images/st-image-atelier/A-1.png');
  assert.equal(tagA.latestResultId, 'A-2');
  assert.deepEqual(messageA.swipe_info[0].extra.stImageAtelier.tags[0], tagA, '当前版本的存档副本一样精简');
  const tagB = messageA.swipe_info[1].extra.stImageAtelier.tags[0];
  assert.equal('attempts' in tagB, false, '另一个滑动版本的存档也处理');
  assert.deepEqual(tagB.resultRefs.map(ref => ref.resultId), ['B-1']);
  const tagC = messageC.extra.stImageAtelier.tags[0];
  assert.deepEqual(tagC.resultRefs.map(ref => ref.resultId), ['C-1']);
  assert.equal(tagC.latestResultId, 'C-1');
  assert.equal(galleryStore.document.results['C-1'].recovered, true, '文件还在的按引用补回画廊');
  const tagD = messageD.extra.stImageAtelier.tags[0];
  assert.equal(tagD.resultRefs.length, 10);
  assert.ok(tagD.resultRefs.some(ref => ref.resultId === 'D-1'), '收藏的留着');
  assert.equal(tagD.resultRefs.some(ref => ref.resultId === 'D-2'), false);
  assert.equal(tagD.latestResultId, 'D-12');
  assert.ok(byteLength(tagD) - byteLength(prompt) < 2048, '除提示词外不到 2 KB');

  assert.equal(attemptStore.forTag('A').length, 20, '搬进去时按上限截断');
  assert.equal(attemptStore.forTag('B').length, 5);
  assert.equal('resolvedPrompt' in attemptStore.forTag('A')[0], false);
  assert.equal('promptSnapshot' in attemptStore.forTag('A')[0], false);
  assert.equal(Object.keys(galleryStore.document.results).length, 15 + 1 - 2);
  assert.equal(galleryStore.document.results['A-1'].prompt, prompt);
  assert.equal('resolvedPrompt' in galleryStore.document.results['A-1'], false, '画廊记录也只留一份提示词');

  const [stateA, stateC, stateD] = await client.resolveTags(['A', 'C', 'D']);
  assert.deepEqual(stateA.results.map(item => item.resultId), aIds, '瘦身后图照样能显示');
  assert.equal(stateA.attempts.length, 20);
  assert.equal(stateA.attempts[0].promptSnapshot, prompt);
  assert.equal(client.fileUrl('A-1'), '/user/images/st-image-atelier/A-1.png');
  assert.deepEqual(stateC.results.map(item => item.resultId), ['C-1']);
  assert.equal(stateD.results.length, 10);
  assert.equal(saves, 1, '读状态没有改动');

  const snapshot = JSON.stringify(chat);
  const again = await client.slimChat();
  assert.equal(again.changed, false, '再跑一次什么都不改');
  assert.equal(again.movedAttempts, 0);
  assert.equal(again.deletedImages, 0);
  assert.equal(again.restoredResults, 0);
  assert.equal(saves, 1, '没改动就不保存');
  assert.equal(JSON.stringify(chat), snapshot);
  assert.equal(again.before.bytes, again.after.bytes);
});

/* 1.7.1 白屏：出图返回、正文写完那一瞬间，酒馆自己要存聊天、要重画，插件再当场整份存一次、写两份文件，
   手机上就白屏。插件的保存并进酒馆的防抖（同一秒只写一次盘），文件写入延后合并，发请求前的防重复记录照样当拍落盘。 */
test('出图后和读状态的改动都走延后合并的保存，不再当场整份存聊天；瘦身仍当场存', async t => {
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
  assert.equal(soon, 1, '出图后的那次保存走防抖');
  assert.equal(immediate, 0, '不当场整份存聊天');
  await client.resolveTags(['legacy']);
  assert.equal(soon, 2, '清掉旧版 results 字段的保存也走防抖');
  assert.equal(immediate, 0);
  await client.slimChat();
  assert.equal(immediate, 1, '瘦身当场存，状态行说「已保存」就是真的');
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
  assert.equal(attemptStore.writes, 1, '上游请求发出之前，记录已经写进文件（不等 2 秒）');
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
