/* 2.1.0 设置页顶部的快捷开关：自动生图、当前预设、当前角色的参考图组。
   它们不另存状态，改它们等于改下面各区块里的原控件；原控件变了它们跟着变。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createToolPanel } from '../../src/ui/pages/settings/settings.js';
import { createStore } from '../../src/ui/state/store.js';

const clone = value => structuredClone(value);

async function waitFor(predicate, message) {
  for (let index = 0; index < 60; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function setup(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tavern.example/' });
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
    generationProvider: 'openai',
    executionMode: 'direct',
    themeMode: 'tavern',
    allowHttp: false,
  };
  const preset = (id, name) => ({
    id,
    name,
    baseUrl: 'https://api.example.com',
    modelsPath: '/v1/models',
    generationPath: '/v1/images/generations',
    selectedModel: 'gpt-image-1',
    cachedModels: [{ id: 'gpt-image-1' }],
    defaultSize: '1024x1024',
    defaultQuality: 'auto',
    defaultCount: 1,
    timeoutMs: 180000,
    responseFormat: 'b64_json',
    extraBody: {},
    hasApiKey: true,
    apiKeyMask: 'sk-••••demo',
  });
  const presets = [preset('p1', '港'), preset('p2', '备用站')];
  let activePresetId = 'p1';
  let overview = {
    sets: [
      { id: 's1', name: '港哥', references: [], useReferences: true, referenceFidelity: '' },
      { id: 's2', name: '小豹子', references: [], useReferences: true, referenceFidelity: '' },
    ],
    defaultSetId: 's1',
    character: { key: 'char:zhong.png', name: '钟由时', setId: null, follows: true },
    activeSetId: 's1',
  };
  const calls = { settings: [], selectPreset: [], bind: [] };
  const api = {
    mode: () => settings.executionMode,
    health: async () => ({ mode: settings.executionMode }),
    getSettings: async () => clone(settings),
    updateSettings: async patch => {
      calls.settings.push(clone(patch));
      settings = { ...settings, ...patch };
      return clone(settings);
    },
    getPresets: async () => ({ activePresetId, items: clone(presets) }),
    updatePreset: async (id, patch) => ({ ...presets.find(item => item.id === id), ...patch }),
    selectPreset: async id => {
      calls.selectPreset.push(id);
      activePresetId = id;
      return clone(presets.find(item => item.id === id));
    },
    getNovelAi: async () => ({
      config: {
        baseUrl: '', model: 'nai-diffusion-4-5-full', sampler: 'k_euler',
        defaultSize: '832x1216', defaultCount: 1, steps: 28, scale: 5,
      },
      artistPresets: [
        { id: 'a1', name: '默认画师串', prompt: '', negativePrompt: '' },
        { id: 'a2', name: '水彩', prompt: '', negativePrompt: '' },
      ],
      activeArtistPresetId: 'a1',
    }),
    getReferenceSets: async () => clone(overview),
    bindReferenceSet: async setId => {
      calls.bind.push(setId);
      overview = {
        ...overview,
        character: { ...overview.character, setId, follows: setId === null },
        activeSetId: setId === null ? overview.defaultSetId : (setId || ''),
      };
      return clone(overview);
    },
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => ({ items: [] }),
    fileUrl: id => `/images/${id}`,
  };
  const store = createStore();
  const panel = createToolPanel({ api, store, onError: () => {} });
  panel.show();
  const page = () => document.querySelector('.stia-settings-page');
  const quick = () => page().querySelector('.stia-quick');
  const change = control => control.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const labelled = (root, text) => [...root.querySelectorAll('label')]
    .filter(label => label.textContent.includes(text))
    .map(label => label.querySelector('input, select'));
  return { dom, api, store, panel, page, quick, change, labelled, calls, state: () => ({ settings, activePresetId, overview }) };
}

test('快捷开关在设置页最上面：自动生图、当前预设、当前角色的参考图组，内容和下面的原控件一样', async t => {
  const { store, page, quick, labelled } = setup(t);
  await waitFor(() => store.state.preset?.id === 'p1', '设置面板未完成初始化');
  await waitFor(() => quick().querySelectorAll('select')[1].options.length === 4, '参考图组还没读进来');

  const sections = [...page().children];
  assert.equal(sections[1], quick(), '紧跟在标题后面');
  assert.ok(sections.indexOf(quick()) < sections.findIndex(node => node.classList.contains('stia-engine-switch')), '在引擎切换上面');

  const [auto] = labelled(quick(), '自动生图');
  assert.equal(auto.type, 'checkbox');
  assert.equal(auto.checked, false);
  const [presetSelect, referenceSelect] = quick().querySelectorAll('select');
  assert.deepEqual([...presetSelect.options].map(option => [option.value, option.textContent]), [['p1', '港'], ['p2', '备用站']]);
  assert.equal(presetSelect.value, 'p1');
  assert.deepEqual(
    [...referenceSelect.options].map(option => [option.value, option.textContent]),
    [['__default__', '跟默认组（港哥）'], ['', '不带参考图'], ['s1', '港哥'], ['s2', '小豹子']],
  );
  assert.equal(referenceSelect.value, '__default__');
  assert.match(quick().textContent, /「钟由时」的参考图组/, '写明是哪个角色的');
});

test('改快捷开关等于改原控件：走原来的保存逻辑；原控件变了，快捷开关跟着变', async t => {
  const { store, page, quick, change, labelled, calls, state } = setup(t);
  await waitFor(() => store.state.preset?.id === 'p1', '设置面板未完成初始化');
  await waitFor(() => quick().querySelectorAll('select')[1].options.length === 4, '参考图组还没读进来');
  const [quickAuto, originalAuto] = labelled(page(), '自动生图');
  assert.notEqual(quickAuto, originalAuto);
  assert.ok(quick().contains(quickAuto) && !quick().contains(originalAuto));

  quickAuto.checked = true;
  change(quickAuto);
  await waitFor(() => calls.settings.some(patch => patch.autoGenerate === true), '快捷开关没有保存自动生图');
  await waitFor(() => originalAuto.checked === true && !originalAuto.disabled, '原开关没跟上');
  assert.equal(store.state.settings.autoGenerate, true);
  assert.equal(quickAuto.checked, true);

  originalAuto.checked = false;
  change(originalAuto);
  await waitFor(() => calls.settings.some(patch => patch.autoGenerate === false), '原开关没有保存');
  await waitFor(() => quickAuto.checked === false, '快捷开关没跟着原开关变');

  const [quickPreset, quickReference] = quick().querySelectorAll('select');
  const originalPreset = page().querySelector('select[aria-label="选择 API 预设"]');
  quickPreset.value = 'p2';
  change(quickPreset);
  await waitFor(() => calls.selectPreset.includes('p2'), '快捷切换预设没有生效');
  await waitFor(() => store.state.preset?.id === 'p2', '当前预设没换');
  assert.equal(originalPreset.value, 'p2', '下面的预设下拉跟着换');
  assert.equal(quickPreset.value, 'p2');
  assert.equal(state().activePresetId, 'p2');

  originalPreset.value = 'p1';
  change(originalPreset);
  await waitFor(() => store.state.preset?.id === 'p1', '原下拉切回去没生效');
  await waitFor(() => quickPreset.value === 'p1', '快捷下拉没跟着原下拉变');

  quickReference.value = 's2';
  change(quickReference);
  await waitFor(() => calls.bind.includes('s2'), '快捷切换参考图组没有生效');
  const originalReference = page().querySelector('select[aria-label="当前角色出图用哪组参考图"]');
  await waitFor(() => originalReference.value === 's2' && quickReference.value === 's2', '两边没对齐');
  quickReference.value = '';
  change(quickReference);
  await waitFor(() => calls.bind.at(-1) === '', '「不带参考图」没生效');
  quickReference.value = '__default__';
  change(quickReference);
  await waitFor(() => calls.bind.at(-1) === null, '「跟默认组」没生效');
  assert.match(page().querySelector('.stia-status').textContent, /跟默认组/, '结果写在状态条上');
});

test('切到 NovelAI：快捷下拉换成画师串预设，参考图组那一项收起（NAI 没有参考图）', async t => {
  const { store, page, quick, calls } = setup(t);
  await waitFor(() => store.state.preset?.id === 'p1', '设置面板未完成初始化');
  const novelAi = [...page().querySelectorAll('.stia-engine-switch button')].find(button => button.textContent === 'NovelAI');
  novelAi.click();
  await waitFor(() => calls.settings.some(patch => patch.generationProvider === 'novelai'), '没有切到 NovelAI');
  const [quickPreset, quickReference] = quick().querySelectorAll('select');
  assert.deepEqual([...quickPreset.options].map(option => option.textContent), ['默认画师串', '水彩']);
  assert.match(quick().textContent, /当前画师串/);
  assert.equal(quickReference.closest('label').hidden, true);

  const openAi = [...page().querySelectorAll('.stia-engine-switch button')].find(button => button.textContent === 'GPT / OpenAI');
  openAi.click();
  await waitFor(() => calls.settings.some(patch => patch.generationProvider === 'openai'), '没有切回 GPT');
  assert.deepEqual([...quickPreset.options].map(option => option.textContent), ['港', '备用站']);
  assert.equal(quickReference.closest('label').hidden, false);
});
