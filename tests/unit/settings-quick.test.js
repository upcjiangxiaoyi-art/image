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

test('设置页「数据文件」（2.4.0）：打开面板时写明画廊索引、生成记录是拆开存的还是整份存的；读不到就留着原来那句，不弹错', async t => {
  const { api, panel, page, store } = setup(t);
  await waitFor(() => store.state.preset?.id === 'p1', '设置面板未完成初始化');
  const notice = () => page().querySelector('.stia-storage-status');
  assert.match(notice().textContent, /拆成小文件存在酒馆里/, '没有状态可读时是一句说明');

  api.storageStatus = async () => ({
    gallery: { mode: 'segmented', segments: 82, records: 1012, migrating: false, error: '' },
    attempts: { mode: 'legacy', segments: 0, records: 7, migrating: true, error: '' },
  });
  panel.show();
  await waitFor(() => notice().textContent.includes('已拆成 82 份'), '状态没写出来');
  assert.equal(
    notice().textContent,
    '画廊索引：已拆成 82 份小文件，共 1012 张图的记录\n生成记录：还是一整份文件，正在后台拆成小文件（共 7 条），拆完之前照旧能用',
  );

  api.storageStatus = async () => { throw new Error('boom'); };
  panel.show();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(notice().textContent, /已拆成 82 份/, '读不到就保持原样');
});

/* 2.5.0 卡片上的「换预设」问面板要可选的预设、让面板去切：走的是面板原来那个选择框自己的逻辑。 */
test('面板给卡片用的两个接口：presetChoices() 说出可选的预设和当前是哪个，selectActivePreset() 切过去后面板、快捷开关、store 一起变', async t => {
  const { store, panel, page, quick, calls, state } = setup(t);
  assert.deepEqual(panel.presetChoices().items, [], '面板还没读完设置时没有可选的');
  await waitFor(() => store.state.preset?.id === 'p1', '设置面板未完成初始化');
  assert.deepEqual(panel.presetChoices(), {
    kind: 'api',
    activeId: 'p1',
    busy: false,
    items: [{ id: 'p1', name: '港' }, { id: 'p2', name: '备用站' }],
  });

  const notified = [];
  store.subscribe((_, change) => notified.push(change));
  assert.deepEqual(await panel.selectActivePreset('p2'), { switched: true, kind: 'api', name: '备用站' });
  assert.deepEqual(calls.selectPreset, ['p2'], '切换走的是面板原来的那一套');
  assert.equal(store.state.preset.id, 'p2');
  assert.ok(notified.some(change => change?.all), '通知所有卡片重画');
  assert.equal(state().activePresetId, 'p2');
  assert.equal(page().querySelector('select[aria-label="选择 API 预设"]').value, 'p2', '面板里的下拉跟着换');
  assert.equal(quick().querySelectorAll('select')[0].value, 'p2', '顶上的快捷下拉也跟着换');
  assert.equal(panel.presetChoices().activeId, 'p2');
  assert.match(page().querySelector('.stia-status').textContent, /已切换到“备用站”/);

  assert.deepEqual(await panel.selectActivePreset('p2'), { switched: true, kind: 'api', name: '备用站' }, '已经是它：直接算成功');
  assert.deepEqual(calls.selectPreset, ['p2'], '不重复切');
  assert.deepEqual(await panel.selectActivePreset('nope'), { switched: false, kind: 'api', name: '' }, '没有这个预设');
  assert.equal(panel.presetChoices().activeId, 'p2');
});

test('selectActivePreset() 没切成：返回没成功，面板的下拉回到原来那个，原因照旧由面板报出来', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tavern.example/' });
  const previous = { document: globalThis.document, window: globalThis.window, navigator: globalThis.navigator };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    dom.window.close();
  });
  const preset = (id, name) => ({
    id, name, baseUrl: 'https://api.example.com', modelsPath: '/v1/models', generationPath: '/v1/images/generations',
    selectedModel: 'gpt-image-1', cachedModels: [{ id: 'gpt-image-1' }], defaultSize: '1024x1024', defaultQuality: 'auto',
    defaultCount: 1, timeoutMs: 180000, responseFormat: 'b64_json', extraBody: {}, hasApiKey: true, apiKeyMask: 'sk-••••demo',
  });
  const settings = { enabled: true, autoGenerate: false, generationProvider: 'openai', executionMode: 'direct', themeMode: 'tavern', allowHttp: false };
  const errors = [];
  const api = {
    mode: () => 'direct',
    health: async () => ({ mode: 'direct' }),
    getSettings: async () => clone(settings),
    updateSettings: async patch => ({ ...settings, ...patch }),
    getPresets: async () => ({ activePresetId: 'p1', items: [preset('p1', '港'), preset('p2', '备用站')] }),
    updatePreset: async (id, patch) => ({ ...preset(id, id === 'p1' ? '港' : '备用站'), ...patch }),
    selectPreset: async () => { throw new Error('切换失败：酒馆没存上'); },
    getNovelAi: async () => ({
      config: { baseUrl: '', model: 'nai-diffusion-4-5-full', sampler: 'k_euler', defaultSize: '832x1216', defaultCount: 1, steps: 28, scale: 5 },
      artistPresets: [{ id: 'a1', name: '默认画师串', prompt: '', negativePrompt: '' }],
      activeArtistPresetId: 'a1',
    }),
    getReferenceSets: async () => ({ sets: [], defaultSetId: '', character: { key: '', name: '', setId: null, follows: true }, activeSetId: '' }),
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => ({ items: [] }),
    fileUrl: id => `/images/${id}`,
  };
  const store = createStore();
  const panel = createToolPanel({ api, store, onError: (error, title) => errors.push([error.message, title]) });
  await waitFor(() => store.state.preset?.id === 'p1', '设置面板未完成初始化');

  assert.deepEqual(await panel.selectActivePreset('p2'), { switched: false, kind: 'api', name: '备用站' });
  assert.equal(panel.presetChoices().activeId, 'p1', '下拉回到原来那个');
  assert.equal(panel.presetChoices().busy, false, '不会卡在忙着');
  assert.equal(store.state.preset.id, 'p1');
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], '切换失败：酒馆没存上');
});

test('NovelAI 时这两个接口说的是画师串', async t => {
  const { api, store, panel, page, calls } = setup(t);
  await waitFor(() => store.state.preset?.id === 'p1', '设置面板未完成初始化');
  const selected = [];
  api.selectArtistPreset = async id => {
    selected.push(id);
    return { id, name: id === 'a2' ? '水彩' : '默认画师串', prompt: '', negativePrompt: '' };
  };
  api.updateArtistPreset = async (id, patch) => ({ id, name: id === 'a2' ? '水彩' : '默认画师串', ...patch });
  [...page().querySelectorAll('.stia-engine-switch button')].find(button => button.textContent === 'NovelAI').click();
  await waitFor(() => calls.settings.some(patch => patch.generationProvider === 'novelai'), '没有切到 NovelAI');
  await waitFor(() => panel.presetChoices().kind === 'artist' && !panel.presetChoices().busy, '面板没换到画师串');
  assert.deepEqual(panel.presetChoices().items, [{ id: 'a1', name: '默认画师串' }, { id: 'a2', name: '水彩' }]);
  assert.equal(panel.presetChoices().activeId, 'a1');

  assert.deepEqual(await panel.selectActivePreset('a2'), { switched: true, kind: 'artist', name: '水彩' });
  assert.deepEqual(selected, ['a2']);
  assert.equal(store.state.artistPreset.id, 'a2');
  assert.equal(panel.presetChoices().activeId, 'a2');
  assert.deepEqual(calls.selectPreset, [], 'API 预设没动');
});
