import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { createMemoryGalleryMetadataStore } from '../../src/ui/api/gallery-metadata-store.js';
import { PNG_BASE64, startMockUpstream } from '../mocks/mock-upstream.js';

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
  assert.ok(chatSaves >= 4);
  assert.ok(settingsSaves >= 3);

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
  assert.equal((await client.gallery()).items.length, 0);
  assert.equal((await client.resolveTags([tagId]))[0].tag.autoSuppressed, true);

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
  assert.deepEqual(tag.resultIds, values.slice(2).map(item => item.resultId));
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
  });
  const [state] = await client.resolveTags([tagId]);
  assert.equal(tag.results, undefined, '聊天里的整份记录清掉');
  assert.deepEqual(tag.resultIds, ['orphan-1'], '可用记录保留在 resultIds 里');
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].prompt, 'orphan prompt');
  assert.equal(client.fileUrl('orphan-1'), '/user/images/st-image-atelier/orphan-1.png');
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
async function gatedClient(t, chat, { save = async () => {} } = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
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
      headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
    },
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
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
  return { client, requests, release, started };
}

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
  assert.equal(archived.attempts[0].status, 'succeeded', '上一版的存档里记着已经画完');
  assert.deepEqual(archived.resultIds, attempt.resultIds);
  assert.equal(archived.latestResultId, attempt.resultIds[0]);
  assert.deepEqual(message.extra.stImageAtelier.tags[0].resultIds, [], '新的一版不受影响');

  /* 滑回上一版：酒馆把存档拷回来。 */
  message.swipe_info[1].extra = structuredClone(message.extra);
  message.swipe_id = 0;
  message.mes = message.swipes[0];
  message.extra = structuredClone(message.swipe_info[0].extra);
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.attempts[0].status, 'succeeded');
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
  assert.equal(savedWhileGenerating.stImageAtelier.tags[0].attempts[0].status, 'generating');

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
  assert.equal(recovered.attempts[0].status, 'succeeded', '画廊里有这次生成的图，接回卡片');
  assert.deepEqual(recovered.attempts[0].resultIds, attempt.resultIds);
  assert.deepEqual(recovered.results.map(result => result.resultId), attempt.resultIds);
  assert.equal(recovered.tag.latestResultId, attempt.resultIds[0]);
  assert.equal(interrupted.attempts[0].status, 'interrupted', '画廊里也没有才算中断');
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
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const client = createDirectApiClient(options);
  const timeouts = async target => Object.fromEntries((await target.getPresets()).items.map(item => [item.id, item.timeoutMs]));
  assert.deepEqual(await timeouts(client), { untouched: 3_600_000, maxed: 3_600_000, custom: 300_000 });
  const created = await client.createPreset({ name: '新的' });
  assert.equal(created.timeoutMs, 3_600_000, '新预设默认 1 小时');

  await client.updatePreset('untouched', { timeoutMs: 180_000 });
  const reloaded = createDirectApiClient({ ...options, galleryStore: createMemoryGalleryMetadataStore() });
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
