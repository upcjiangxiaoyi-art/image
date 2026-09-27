import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createToolPanel } from '../../src/ui/pages/settings/settings.js';
import { createStore } from '../../src/ui/state/store.js';

function clone(value) {
  return structuredClone(value);
}

async function waitFor(predicate, message) {
  for (let index = 0; index < 40; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('总开关即时持久化，独立保存生图参数后立即更新当前预设', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://tavern.example/',
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    confirm: globalThis.confirm,
  };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.confirm = () => true;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    globalThis.confirm = previous.confirm;
    dom.window.close();
  });

  let settings = {
    enabled: true,
    autoGenerate: false,
    enablePromptOverrideRegenerate: false,
    enableSmartRetry: false,
    generationProvider: 'openai',
    executionMode: 'direct',
    themeMode: 'tavern',
    allowHttp: false,
  };
  let preset = {
    id: 'default',
    name: '主站 API',
    baseUrl: 'https://api.example.com',
    modelsPath: '/v1/models',
    generationPath: '/v1/images/generations',
    selectedModel: 'gpt-image-1',
    cachedModels: [{ id: 'gpt-image-1' }],
    defaultSize: '1024x1024',
    defaultQuality: 'auto',
    defaultCount: 1,
    sendSize: true,
    sendQuality: true,
    sendN: true,
    timeoutMs: 180000,
    responseFormat: 'b64_json',
    extraBody: {},
    hasApiKey: true,
    apiKeyMask: 'sk-••••demo',
  };
  const settingsPatches = [];
  const presetPatches = [];
  const api = {
    mode: () => settings.executionMode,
    health: async () => ({ mode: settings.executionMode }),
    getSettings: async () => clone(settings),
    updateSettings: async patch => {
      settingsPatches.push(clone(patch));
      settings = { ...settings, ...patch };
      return clone(settings);
    },
    getPresets: async () => ({ activePresetId: preset.id, items: [clone(preset)] }),
    updatePreset: async (_id, patch) => {
      presetPatches.push(clone(patch));
      preset = { ...preset, ...patch };
      return clone(preset);
    },
    getNovelAi: async () => ({
      config: {
        baseUrl: '', model: 'nai-diffusion-4-5-full', sampler: 'k_euler',
        defaultSize: '832x1216', defaultCount: 1, steps: 28, scale: 5,
      },
      artistPresets: [{ id: 'default', name: '默认画师串', prompt: '', negativePrompt: '' }],
      activeArtistPresetId: 'default',
    }),
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => ({ items: [] }),
    fileUrl: id => `/images/${id}`,
    testPreset: async () => {
      throw Object.assign(new Error('浏览器连不上生图接口'), { code: 'DIRECT_FETCH_BLOCKED' });
    },
  };
  const store = createStore();
  const reportedErrors = [];
  const panel = createToolPanel({
    api,
    store,
    onError: (error, title) => reportedErrors.push({ error, title }),
  });
  panel.show();

  await waitFor(() => store.state.preset?.id === 'default', '设置面板未完成初始化');
  const labels = () => [...document.querySelectorAll('.stia-settings-page label')];
  const controlFor = text => labels().find(label => label.textContent.includes(text))?.querySelector('input, select');

  const enabled = controlFor('扩展已启用');
  enabled.checked = false;
  enabled.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await waitFor(() => settingsPatches.some(patch => patch.enabled === false), '总开关没有立即写入设置');
  assert.equal(settings.enabled, false);
  assert.equal(store.state.settings.enabled, false);

  await panel.load();
  assert.equal(enabled.checked, false, '重新打开设置后不应反弹为开启');

  const size = controlFor('默认尺寸');
  const quality = controlFor('默认质量');
  const count = controlFor('默认数量');
  size.value = '512x768';
  quality.value = 'high';
  count.value = '2';
  for (const control of [size, quality, count]) {
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  }
  assert.match(document.querySelector('.stia-settings-page').textContent, /参数已修改/);

  const saveParameters = [...document.querySelectorAll('button')]
    .find(button => button.textContent.includes('保存生图参数'));
  saveParameters.click();
  await waitFor(() => presetPatches.some(patch => patch.defaultSize === '512x768'), '生图参数没有独立保存');
  assert.deepEqual(presetPatches.at(-1), {
    defaultSize: '512x768',
    defaultQuality: 'high',
    defaultCount: 2,
    sendSize: true,
    sendQuality: true,
    sendN: true,
  });
  assert.equal(store.state.preset.defaultSize, '512x768');
  assert.equal(store.state.preset.defaultQuality, 'high');
  assert.equal(store.state.preset.defaultCount, 2);

  await panel.load();
  assert.equal(size.value, '512x768');
  assert.equal(quality.value, 'high');
  assert.equal(count.value, '2');

  quality.value = 'max';
  assert.equal(quality.value, 'max', '下拉里直接有 max 可选');
  quality.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  saveParameters.click();
  await waitFor(() => presetPatches.at(-1)?.defaultQuality === 'max', 'max 没有保存');
  assert.equal(presetPatches.at(-1).sendQuality, true);
  await panel.load();
  assert.equal(quality.value, 'max');
  assert.equal([...quality.options].filter(option => option.value === 'max').length, 1);

  const errorPopup = controlFor('报错弹窗');
  assert.equal(errorPopup.checked, true, '旧设置没有这一项时报错弹窗默认开启');
  errorPopup.checked = false;
  errorPopup.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await waitFor(() => settingsPatches.some(patch => patch.enableErrorPopup === false), '报错弹窗开关没有立即保存');
  assert.equal(store.state.settings.enableErrorPopup, false);
  await panel.load();
  assert.equal(errorPopup.checked, false, '重新打开设置后保持关闭');

  [...document.querySelectorAll('button')].find(button => button.textContent.includes('测试模型接口')).click();
  await waitFor(() => reportedErrors.length === 1, '测试模型接口失败没有交给报错弹窗');
  assert.equal(reportedErrors[0].title, '测试模型接口失败');
  assert.equal(reportedErrors[0].error.code, 'DIRECT_FETCH_BLOCKED');
  assert.match(document.querySelector('.stia-settings-page').textContent, /浏览器连不上生图接口/, '设置页状态栏照旧显示');

  const novelAiSection = document.querySelector('.stia-section--novelai');
  const novelAiField = text => [...novelAiSection.querySelectorAll('label')]
    .find(label => label.firstElementChild?.textContent === text);
  const novelAiModel = novelAiField('模型').querySelector('select');
  const legacyQuality = novelAiField('自动加入模型质量标签');
  const v5Quality = novelAiField('V5 质量词预设');
  const v5Uc = novelAiField('V5 负面预设');
  assert.equal(legacyQuality.hidden, false);
  assert.equal(v5Quality.hidden, true);
  assert.equal(v5Uc.hidden, true);

  novelAiModel.value = 'nai-diffusion-5-full';
  novelAiModel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(legacyQuality.hidden, true);
  assert.equal(v5Quality.hidden, false);
  assert.equal(v5Uc.hidden, false);

  novelAiModel.value = 'nai-diffusion-4-5-full';
  novelAiModel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(legacyQuality.hidden, false);
  assert.equal(v5Quality.hidden, true);
  assert.equal(v5Uc.hidden, true);
});
