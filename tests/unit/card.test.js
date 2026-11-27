import test from 'node:test';
import assert from 'node:assert/strict';
import { createCard, formatDuration, formatElapsed, generationDuration, imageInfo } from '../../src/ui/renderer/card.js';
import { blankIcons, iconOf } from '../helpers/icons.js';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.className = '';
    this.textContent = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener() {}
}

function allElements(element) {
  return [element, ...element.children.flatMap(allElements)];
}

function renderedText(element) {
  return allElements(element).map(item => item.textContent).filter(Boolean).join(' ');
}

test('已有图片重新生成时优先显示加载动画而不是继续显示旧图', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });

  const tag = { tagId: 'tag-1', prompt: 'adult woman', ratio: 'portrait' };
  const state = {
    tag: { latestResultId: 'old-result' },
    attempts: [{
      attemptId: 'new-attempt',
      status: 'generating',
      requestMode: 'manual',
      model: 'nai-diffusion-5-full',
      parameters: { size: '512x768' },
    }],
    results: [{ resultId: 'old-result', status: 'available' }],
  };
  const card = createCard({
    tag,
    api: { fileUrl: () => '/old.png' },
    getState: () => state,
    onGenerate: () => {},
    onOpenGallery: () => {},
    onCancel: () => {},
  });
  card.render();

  assert.equal(card.root.classList.contains('stia-card--generating'), true);
  assert.match(renderedText(card.root), /正在重新生成/);
  assert.ok(allElements(card.root).some(item => item.className === 'stia-card__shimmer'));
  assert.equal(allElements(card.root).some(item => item.tagName === 'img'), false);
});

/* 一键删除按钮 —— 失败与待生成两种状态提供，生成中和已出图不提供 */
class ClickableElement extends FakeElement {
  constructor(tagName) {
    super(tagName);
    this.handlers = {};
  }

  addEventListener(type, handler) {
    this.handlers[type] = handler;
  }
}

function findButton(root, label) {
  return allElements(root).find(element =>
    element.tagName === 'button' && element.children.some(child => child.textContent === label));
}

function cardWith(state, onRemove) {
  const tag = { tagId: 'tag-1', prompt: 'adult woman', ratio: 'portrait' };
  const card = createCard({
    tag,
    api: { fileUrl: id => `/file/${id}` },
    getState: () => state,
    onGenerate: () => {},
    onOpenGallery: () => {},
    onCancel: () => {},
    onRemove,
  });
  card.render();
  return { card, tag };
}

test('失败和待生成的卡片带「删除」按钮，点击把整条标签交给 onRemove', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new ClickableElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });

  const removed = [];
  const failed = cardWith({ attempts: [{ status: 'failed', errorMessage: 'HTTP 451' }], results: [] }, tag => removed.push(tag));
  const failedButton = findButton(failed.card.root, '删除');
  assert.ok(failedButton, '失败卡片要有删除按钮');
  failedButton.handlers.click();
  assert.deepEqual(removed, [failed.tag]);

  const idle = cardWith({ attempts: [], results: [] }, tag => removed.push(tag));
  assert.ok(findButton(idle.card.root, '删除'), '待生成卡片要有删除按钮');
});

test('生成中和已出图的卡片不提供「删除」，没传 onRemove 时也不显示', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new ClickableElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });

  const generating = cardWith({ attempts: [{ status: 'generating' }], results: [] }, () => {});
  assert.equal(findButton(generating.card.root, '删除'), undefined);
  const succeeded = cardWith({
    tag: { latestResultId: 'r1' },
    attempts: [{ status: 'succeeded' }],
    results: [{ resultId: 'r1', status: 'available' }],
  }, () => {});
  assert.equal(findButton(succeeded.card.root, '删除'), undefined);
  const noHandler = cardWith({ attempts: [{ status: 'failed' }], results: [] }, undefined);
  assert.equal(findButton(noHandler.card.root, '删除'), undefined);
});

test('别的卡片有动静时这张卡不重建：图片不换、不闪，展开的提示词不收起；换了新图才换 <img>', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });

  const tag = { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' };
  const result = (resultId, prompt = 'a cat') => ({ resultId, status: 'available', prompt });
  let state = {
    tag: { latestResultId: 'r1', resultIds: ['r1'] },
    attempts: [{ attemptId: 'a1', status: 'succeeded', model: 'gpt-image-2.5-sunburst', parameters: { size: '1024x1792' } }],
    results: [result('r1')],
  };
  const card = createCard({
    tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  card.render();
  document.body.append(card.root);
  const image = card.root.querySelector('img');
  const details = card.root.querySelector('details');
  details.open = true;

  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(card.root, { childList: true, subtree: true, attributes: true, characterData: true });
  state = structuredClone(state);
  for (let index = 0; index < 5; index += 1) card.render();
  assert.equal(observer.takeRecords().length, 0, '状态内容没变（哪怕是新对象）就零 DOM 变动');
  assert.equal(card.root.querySelector('img'), image);
  assert.equal(details.open, true, '展开的「查看提示词」不会被收起');

  state = { ...state, results: [result('r0', 'older'), result('r1')] };
  card.render();
  assert.match(card.root.textContent, /历史 2 张/, '张数变了就更新');
  assert.equal(card.root.querySelector('.stia-card__pager-count').textContent, '2 / 2', '两张以上出现翻看那一行');
  assert.equal(card.root.querySelector('img'), image, '还是同一张图时沿用原来的 <img>，不重新加载');

  state = { ...state, attempts: [{ attemptId: 'a2', status: 'generating', model: 'gpt-image-2.5-sunburst' }, ...state.attempts] };
  card.render();
  assert.equal(card.root.querySelector('img'), null, '重新生成中显示加载动画');
  state = { ...state, attempts: state.attempts.slice(1) };
  card.render();
  assert.equal(card.root.querySelector('img'), image, '取消重新生成、回到原图时也不重新加载');

  state = {
    ...state,
    tag: { latestResultId: 'r2', resultIds: ['r0', 'r1', 'r2'] },
    results: [result('r0', 'older'), result('r1'), result('r2')],
  };
  card.render();
  const next = card.root.querySelector('img');
  assert.notEqual(next, image, '换成新的一张图才换 <img>');
  assert.equal(next.getAttribute('src'), '/user/images/r2.png');
  observer.disconnect();
});

test('计时文字：一分钟内按秒，超过一分钟按分秒，不显示负数', () => {
  assert.equal(formatElapsed(0), '已用 0 秒');
  assert.equal(formatElapsed(42_900), '已用 42 秒');
  assert.equal(formatElapsed(65_000), '已用 1 分 05 秒');
  assert.equal(formatElapsed(3_600_000), '已用 60 分 00 秒');
  assert.equal(formatElapsed(-3_000), '已用 0 秒', '服务端时钟比浏览器快时不显示负数');
  assert.equal(formatElapsed(Number.NaN), '已用 0 秒');
});

test('生成中的卡片显示计时：从这次生成开始时算起，每秒只改那几个字、不重画卡片', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });

  const tag = { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' };
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  let state = {
    attempts: [{ attemptId: 'a1', status: 'generating', requestMode: 'manual', model: 'gpt-image-2.5-sunburst', createdAt: startedAt }],
    results: [],
  };
  const card = createCard({
    tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  card.render();
  document.body.append(card.root);
  const timer = card.root.querySelector('.stia-card__status .stia-card__elapsed');
  assert.ok(timer, '计时挂在状态行上');
  assert.equal(timer.getAttribute('role'), 'timer');
  assert.match(timer.textContent, /^已用 1 分 0[56] 秒$/);
  const since = timer.dataset.since;

  /* 整页共用一个每秒一次的定时器，它从哪一刻开始跳不一定，所以等到文字变了为止（最多 2.5 秒）。 */
  const before = timer.textContent;
  const shimmer = card.root.querySelector('.stia-card__shimmer');
  const deadline = Date.now() + 2_500;
  while (timer.textContent === before && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.notEqual(timer.textContent, before, '每秒自己往上走');
  assert.equal(card.root.querySelector('.stia-card__shimmer'), shimmer, '只改计时文字，卡片不重画');

  state = {
    ...state,
    attempts: [{ ...state.attempts[0], status: 'downloading', createdAt: new Date().toISOString() }],
  };
  card.render();
  assert.equal(
    card.root.querySelector('.stia-card__elapsed').dataset.since,
    since,
    '同一次生成里换状态（开始下载、保存）不重新计时',
  );

  state = { ...state, attempts: [{ attemptId: 'a2', status: 'generating', requestMode: 'manual' }] };
  card.render();
  assert.match(card.root.querySelector('.stia-card__elapsed').textContent, /^已用 0 秒$/, '新的一次生成从零开始');

  state = { ...state, attempts: [{ attemptId: 'auto:tag-1', status: 'queued', requestMode: 'auto' }] };
  card.render();
  assert.equal(card.root.querySelector('.stia-card__elapsed'), null, '自动排队时还没开始画，不计时');

  state = {
    tag: { latestResultId: 'r1', resultIds: ['r1'] },
    attempts: [{ attemptId: 'a3', status: 'succeeded' }],
    results: [{ resultId: 'r1', status: 'available', prompt: 'a cat' }],
  };
  card.render();
  assert.equal(card.root.querySelector('.stia-card__elapsed'), null, '画完就不显示计时');
});

test('生成中可以「再画一张」：选预设（当前的排前面、没填 Key 的注明），正在画的那张显示在后台', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });

  const tag = { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' };
  const startedSlow = new Date(Date.now() - 18 * 60_000).toISOString();
  let state = {
    attempts: [{ attemptId: 'slow', status: 'generating', requestMode: 'manual', model: 'm', createdAt: startedSlow }],
    results: [],
  };
  let settings = { generationProvider: 'openai' };
  const rerolls = [];
  const presets = [
    { id: 'fast', name: '快速组', active: false, hasApiKey: true },
    { id: 'cheap', name: '便宜组', active: true, hasApiKey: true },
    { id: 'empty', name: '新预设', active: false, hasApiKey: false },
  ];
  const card = createCard({
    tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    getSettings: () => settings,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
    onRemove() {},
    onReroll: (...args) => rerolls.push(args),
    listPresets: async () => presets,
  });
  card.render();
  document.body.append(card.root);
  const buttons = () => [...card.root.querySelectorAll('button')].map(button => button.textContent);
  const click = label => [...card.root.querySelectorAll('button')].find(button => button.textContent === label).click();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(buttons(), ['再画一张', '取消']);
  assert.deepEqual([...card.root.querySelectorAll('button')].map(iconOf), ['refresh', 'close']);
  assert.equal(iconOf(card.root.querySelector('.stia-card__status')), 'spinner', '正在画：一个转着的圈');
  assert.ok(card.root.querySelector('.stia-card__status .stia-icon').classList.contains('is-spinning'));
  assert.deepEqual(blankIcons(card.root), []);
  click('再画一张');
  await settle();
  assert.match(card.root.textContent, /这张会在后台接着画。用哪个预设再画一张？/);
  assert.deepEqual(buttons(), ['便宜组（当前）', '快速组', '新预设（没填 Key）', '算了']);
  click('算了');
  assert.deepEqual(buttons(), ['再画一张', '取消'], '「算了」收起');

  click('再画一张');
  await settle();
  click('快速组');
  assert.equal(rerolls.length, 1);
  assert.equal(rerolls[0][0], tag);
  assert.equal(rerolls[0][1], 'slow', '照正在画的那次请求再来一张');
  assert.equal(rerolls[0][2].id, 'fast');

  state = {
    ...state,
    attempts: [{ attemptId: 'quick', status: 'generating', requestMode: 'manual', createdAt: new Date().toISOString() }, ...state.attempts],
  };
  card.render();
  const note = card.root.querySelector('.stia-card__background');
  assert.match(note.textContent, /^后台还有 1 张在画 · 已用 1[78] 分 \d\d 秒$/);
  assert.match(card.root.querySelector('.stia-card__status .stia-card__elapsed').textContent, /^已用 0 秒$/, '新的这次从零开始计时');

  state = {
    tag: { latestResultId: 'r-quick', resultIds: ['r-quick'] },
    attempts: [{ ...state.attempts[0], status: 'succeeded' }, state.attempts[1]],
    results: [{ resultId: 'r-quick', status: 'available', prompt: 'a cat' }],
  };
  card.render();
  assert.ok(card.root.querySelector('img'), '新的这张画好了先显示');
  assert.match(card.root.querySelector('.stia-card__background').textContent, /后台还有 1 张在画/);

  state = { tag: {}, attempts: [{ attemptId: 'quick', status: 'failed', errorMessage: 'x' }, state.attempts[1]], results: [] };
  card.render();
  assert.equal(buttons().includes('删除'), false, '后台还在画时不给删除');

  settings = { generationProvider: 'novelai' };
  state = { attempts: [{ attemptId: 'nai', status: 'generating', requestMode: 'manual' }], results: [] };
  card.render();
  click('再画一张');
  await settle();
  assert.deepEqual(buttons(), ['确定再画一张', '算了'], 'NovelAI 没有 API 预设可选，确认一下就画');
  click('确定再画一张');
  assert.deepEqual(rerolls.at(-1).slice(1), ['nai', undefined]);

  state = { attempts: [{ attemptId: 'auto:tag-1', status: 'queued', requestMode: 'auto' }], results: [] };
  card.render();
  assert.deepEqual(buttons(), ['取消排队'], '自动排队时还没开始画，没有「再画一张」');
  assert.deepEqual(blankIcons(card.root), []);
});

test('出图后「已完成」旁边显示这张图用了多久，图片上不压东西；记录不全时不显示', async t => {
  assert.equal(formatDuration(42_000), '42 秒');
  assert.equal(formatDuration(997_000), '16 分 37 秒');
  assert.equal(generationDuration({ createdAt: '2026-10-03T05:00:00.000Z', completedAt: '2026-10-03T05:16:37.400Z' }), '用时 16 分 37 秒');
  assert.equal(generationDuration({ createdAt: '2026-10-03T05:00:00.000Z' }), '', '还没结束（没有 completedAt）');
  assert.equal(generationDuration({ createdAt: '2026-10-03T05:00:10.000Z', completedAt: '2026-10-03T05:00:00.000Z' }), '', '时间对不上');
  assert.equal(generationDuration(undefined), '');

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });

  const slow = { attemptId: 'slow', status: 'succeeded', createdAt: '2026-10-03T05:00:00.000Z', completedAt: '2026-10-03T05:16:37.000Z', parameters: { size: '1024x1792' } };
  let state = {
    tag: { latestResultId: 'r-slow', resultIds: ['r-slow'] },
    attempts: [slow],
    results: [{ resultId: 'r-slow', attemptId: 'slow', status: 'available', prompt: 'a cat' }],
  };
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' },
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  card.render();
  const badge = () => card.root.querySelector('.stia-card__completion-status .stia-card__duration');
  assert.equal(badge().textContent, '用时 16 分 37 秒');
  assert.equal(card.root.querySelector('.stia-card__completion-status').textContent, '已完成用时 16 分 37 秒');
  assert.deepEqual(
    [...card.root.querySelector('.stia-card__media').children].map(child => child.tagName),
    ['IMG'],
    '图片上不再压用时和尺寸角标',
  );
  assert.match(card.root.querySelector('.stia-card__completion-meta').textContent, /1024×1792/, '尺寸在「历史 N 张」旁边');

  state = {
    ...state,
    attempts: [{ attemptId: 'quick', status: 'failed', createdAt: '2026-10-03T05:20:00.000Z', completedAt: '2026-10-03T05:20:05.000Z' }, slow],
  };
  card.render();
  assert.equal(badge().textContent, '用时 16 分 37 秒', '新的那次没画成：显示的还是旧图，用时也跟着旧图');

  state = { ...state, attempts: [], results: [{ resultId: 'r-slow', status: 'available', prompt: 'a cat' }] };
  card.render();
  assert.equal(badge(), null, '老图片没有生成记录就不显示');
});

test('出图后卡片下方显示这张图的预设、画质、模型，尺寸放在「历史 N 张」旁边', async t => {
  const result = { resultId: 'r1', attemptId: 'a1', status: 'available', prompt: 'a cat', provider: 'openai', presetNameSnapshot: '纯爱2.5', apiModel: 'gpt-image-2.5-sunburst' };
  const producer = { attemptId: 'a1', status: 'succeeded', provider: 'openai', model: 'gpt-image-2.5-sunburst', presetNameSnapshot: '纯爱2.5', qualitySnapshot: 'max', parameters: { size: '1024x1792' } };
  assert.deepEqual(imageInfo(result, producer), {
    presetLabel: '预设', preset: '纯爱2.5', model: 'gpt-image-2.5-sunburst', quality: 'max', size: '1024×1792', references: 0,
    fidelityRejected: false,
  });
  assert.equal(imageInfo({ ...result, references: ['a.png', 'b.png'] }, producer).references, 2, '图片记录上记着带了几张参考图');
  /* 2.5.2 线路不认高保真参考：这张是去掉 input_fidelity 画的。 */
  const withReferences = { ...result, references: ['a.png', 'b.png'] };
  assert.equal(imageInfo(withReferences, producer).fidelityRejected, false);
  assert.equal(
    imageInfo(withReferences, { ...producer, compatibilityRetry: { adjustedParameters: ['input_fidelity'] } }).fidelityRejected,
    true,
    '智能重试去掉了 input_fidelity',
  );
  assert.equal(
    imageInfo({ ...withReferences, compatibilityRetry: { remembered: true, adjustedParameters: ['input_fidelity'] } }, null).fidelityRejected,
    true,
    '记着这条线路不认、一开始就没带的也算；生成记录清掉以后看图片记录',
  );
  assert.equal(
    imageInfo(result, { ...producer, compatibilityRetry: { adjustedParameters: ['input_fidelity'] } }).fidelityRejected,
    false,
    '没带参考图就谈不上',
  );
  assert.equal(imageInfo(result, { ...producer, qualitySnapshot: '' }).quality, '默认', '没发 quality 时按上游默认');
  assert.equal(
    imageInfo(result, { ...producer, compatibilityRetry: { adjustedParameters: ['quality'] } }).quality,
    '默认（max 被拒）',
    '智能重试去掉了 quality',
  );
  assert.equal(imageInfo(result, { ...producer, compatibilityRetry: { adjustedParameters: ['size'] } }).size, '默认尺寸');
  const { qualitySnapshot: _omit, ...old } = producer;
  assert.equal(imageInfo(result, { ...old, parameters: { size: '1024x1792', quality: 'high' } }).quality, 'high', '旧记录里标签写过画质');
  assert.equal(imageInfo(result, old).quality, '', '旧记录里没有就不显示');
  const novelai = imageInfo(
    { ...result, provider: 'novelai', artistPresetNameSnapshot: '水彩画师串', apiModel: 'nai-diffusion-4-5-full' },
    { ...producer, provider: 'novelai', qualitySnapshot: undefined },
  );
  assert.equal(novelai.presetLabel, '画师串');
  assert.equal(novelai.preset, '水彩画师串');
  assert.equal(novelai.quality, '', 'NovelAI 没有画质参数');

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });
  let state = { tag: { latestResultId: 'r1', resultIds: ['r1'] }, attempts: [producer], results: [result] };
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' },
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  card.render();
  const rows = () => [...card.root.querySelectorAll('.stia-card__info-item')].map(item => item.textContent);
  assert.deepEqual(rows(), ['预设纯爱2.5', '画质max', '模型gpt-image-2.5-sunburst']);
  assert.equal(card.root.querySelector('.stia-card__completion-meta').textContent, '历史 1 张1024×1792');
  const body = card.root.querySelector('.stia-card__body');
  const order = [...body.children].map(child => child.className.split(' ')[0]);
  assert.deepEqual(order.slice(0, 3), ['stia-card__completion', 'stia-card__info', 'stia-actions'], '信息在「已完成」下面、按钮上面');

  const { qualitySnapshot: _old, ...beforeQualityWasRecorded } = producer;
  state = { ...state, attempts: [beforeQualityWasRecorded] };
  card.render();
  assert.deepEqual(rows(), ['预设纯爱2.5', '画质未记录', '模型gpt-image-2.5-sunburst'], '1.6.18 之前的图没记画质：写「未记录」');
  assert.equal(card.root.querySelector('.stia-card__info dd.is-unknown').textContent, '未记录');

  state = { ...state, attempts: [], results: [{ resultId: 'r1', status: 'available', prompt: 'a cat' }] };
  card.render();
  assert.equal(card.root.querySelector('.stia-card__info'), null, '老图片什么记录都没有就不显示这一块');
});

test('失败的卡片上「换备用线路」：设了备用线路、这次用的不是它才给；审核拦截、取消、增强模式不给；「再画一张」里标出备用', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });

  const tag = { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' };
  const failed = { attemptId: 'a1', status: 'failed', provider: 'openai', presetId: 'cheap', errorCode: 'UPSTREAM_HTTP_ERROR', errorMessage: '上游生图请求失败（HTTP 502）' };
  let state = { attempts: [failed], results: [] };
  let settings = { generationProvider: 'openai', executionMode: 'direct', backupPresetId: 'stable' };
  const fallbacks = [];
  const card = createCard({
    tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    getSettings: () => settings,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
    onRemove() {},
    onReroll() {},
    onFallback: value => fallbacks.push(value),
    listPresets: async () => [
      { id: 'other', name: '别的组', active: false, backup: false },
      { id: 'stable', name: '稳定组', active: false, backup: true },
      { id: 'cheap', name: '便宜组', active: true, backup: false },
    ],
  });
  card.render();
  const buttons = () => [...card.root.querySelectorAll('button:not(.stia-copy)')].map(button => button.textContent);
  assert.deepEqual(buttons(), ['重试', '换备用线路', '删除']);
  [...card.root.querySelectorAll('button')].find(button => button.textContent === '换备用线路').click();
  assert.deepEqual(fallbacks, [tag]);

  const without = expected => {
    card.render();
    assert.equal(buttons().includes('换备用线路'), false, expected);
  };
  state = { attempts: [{ ...failed, presetId: 'stable' }], results: [] };
  without('这次用的本来就是备用线路');
  state = { attempts: [{ ...failed, errorMessage: '上游生图请求失败（HTTP 400）：prompt is unsafe' }], results: [] };
  without('审核拦截，换了也出不来');
  state = { attempts: [{ ...failed, status: 'cancelled', errorMessage: '已取消' }], results: [] };
  without('用户自己取消的');
  state = { attempts: [failed], results: [] };
  settings = { ...settings, executionMode: 'server' };
  without('增强模式只有一个预设');
  settings = { ...settings, executionMode: 'direct', backupPresetId: '' };
  without('没设备用线路');

  settings = { ...settings, backupPresetId: 'stable' };
  state = { attempts: [{ attemptId: 'a2', status: 'generating', requestMode: 'manual' }], results: [] };
  card.render();
  [...card.root.querySelectorAll('button')].find(button => button.textContent === '再画一张').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(buttons(), ['便宜组（当前）', '稳定组（备用）', '别的组', '算了'], '当前的第一，备用的第二');
});

test('同一张卡有好几张图时，在卡片上左右翻看：信息跟着看的那张，来回切不重新加载；有新图画好回到新图', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });

  const attemptFor = (id, preset, quality, minutes) => ({
    attemptId: id, status: 'succeeded', provider: 'openai', model: 'gpt-image-2.5-sunburst', presetNameSnapshot: preset,
    qualitySnapshot: quality, parameters: { size: '1024x1792' },
    createdAt: '2026-10-05T01:00:00.000Z', completedAt: new Date(Date.parse('2026-10-05T01:00:00.000Z') + minutes * 60_000).toISOString(),
  });
  const resultFor = (id, attemptId, prompt) => ({ resultId: id, attemptId, status: 'available', prompt, provider: 'openai', apiModel: 'gpt-image-2.5-sunburst' });
  let state = {
    tag: { latestResultId: 'r3', resultIds: ['r1', 'r2', 'r3'] },
    attempts: [attemptFor('a3', '纯爱二号', 'max', 3), attemptFor('a2', '稳定组', 'high', 2), attemptFor('a1', '纯爱二号', 'max', 1)],
    results: [resultFor('r1', 'a1', '第一版'), resultFor('r2', 'a2', '第二版'), resultFor('r3', 'a3', '第三版')],
  };
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' },
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
    listPresets: async () => [{ id: 'p1', name: '纯爱二号', active: true }, { id: 'p2', name: '稳定组' }],
  });
  card.render();
  document.body.append(card.root);
  const shownSrc = () => card.root.querySelector('img').getAttribute('src');
  const counter = () => card.root.querySelector('.stia-card__pager-count')?.textContent;
  const history = () => card.root.querySelector('.stia-card__completion-meta .stia-muted').textContent;
  const duration = () => card.root.querySelector('.stia-card__completion .stia-card__duration').textContent;
  const rows = () => [...card.root.querySelectorAll('.stia-card__info-item')].map(item => item.textContent);
  /* 翻看的两个键只有箭头图标，名字写在 aria-label 上。 */
  const pagerButton = label => [...card.root.querySelectorAll('.stia-card__pager button')]
    .find(item => item.getAttribute('aria-label') === label);
  const click = label => pagerButton(label).click();

  assert.equal(shownSrc(), '/user/images/r3.png', '先显示最新那张');
  assert.equal(counter(), '3 / 3');
  assert.deepEqual(
    [...card.root.querySelectorAll('.stia-card__pager > *')].map(item => item.getAttribute('aria-label') || item.textContent),
    ['上一张', '3 / 3', '下一张'],
  );
  assert.deepEqual(
    [...card.root.querySelectorAll('.stia-card__pager button')].map(iconOf),
    ['chevron-left', 'chevron-right'],
  );
  assert.equal(history(), '历史 3 张');
  assert.equal(duration(), '用时 3 分 00 秒');
  assert.deepEqual(
    [...card.root.querySelector('.stia-card__media').children].map(child => child.tagName),
    ['IMG'],
    '翻看按钮和用时都不压在图片上',
  );
  const order = [...card.root.querySelector('.stia-card__body').children].map(child => child.className.split(' ')[0]);
  assert.deepEqual(
    order.slice(0, 4),
    ['stia-card__completion', 'stia-card__info', 'stia-card__pager', 'stia-actions'],
    '翻看那一行在分隔线下面、按钮上面',
  );
  assert.equal(pagerButton('下一张').disabled, true, '已经是最新那张：「下一张」是灰的');
  assert.equal(pagerButton('上一张').disabled, false);
  const newest = card.root.querySelector('img');

  click('上一张');
  assert.equal(shownSrc(), '/user/images/r2.png');
  assert.equal(counter(), '2 / 3');
  assert.equal(history(), '历史 3 张', '右上角还是一共几张');
  assert.deepEqual(rows(), ['预设稳定组', '画质high', '模型gpt-image-2.5-sunburst'], '预设、画质跟着正在看的这张');
  assert.equal(duration(), '用时 2 分 00 秒');
  assert.equal(card.root.querySelector('.stia-prompt pre').textContent, '第二版', '提示词也跟着');
  assert.equal(pagerButton('上一张').disabled, false);
  assert.equal(pagerButton('下一张').disabled, false);

  click('上一张');
  assert.equal(counter(), '1 / 3');
  assert.equal(pagerButton('上一张').disabled, true, '到第一张了：「上一张」是灰的');
  click('上一张');
  assert.equal(counter(), '1 / 3', '到头了不绕回去');
  assert.equal(shownSrc(), '/user/images/r1.png');

  click('下一张');
  click('下一张');
  assert.equal(counter(), '3 / 3');
  assert.equal(card.root.querySelector('img'), newest, '切回来还是原来那个 <img>，不重新加载');

  click('上一张');
  click('上一张');
  assert.equal(counter(), '1 / 3');
  state = { ...state, attempts: [{ attemptId: 'other', status: 'failed' }, ...state.attempts] };
  card.render();
  assert.equal(counter(), '1 / 3', '别的动静（比如新的一次没画成）不打断正在看的');

  const bodyButton = label => [...card.root.querySelectorAll('.stia-card__body button')].find(item => item.textContent === label);
  bodyButton('重新生成').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(card.root.querySelector('.stia-card__pager'), null, '选预设重新生成时先收起翻看');
  assert.ok(bodyButton('纯爱二号（当前）'));
  bodyButton('算了').click();
  assert.equal(counter(), '1 / 3', '「算了」以后翻看回来，还在看原来那张');

  state = {
    tag: { latestResultId: 'r4', resultIds: ['r1', 'r2', 'r3', 'r4'] },
    attempts: [attemptFor('a4', '纯爱二号', 'max', 4), ...state.attempts.slice(1)],
    results: [...state.results, resultFor('r4', 'a4', '第四版')],
  };
  card.render();
  assert.equal(shownSrc(), '/user/images/r4.png', '有新图画好就回到新图');
  assert.equal(counter(), '4 / 4');
  assert.equal(history(), '历史 4 张');

  state = { tag: { latestResultId: 'r4', resultIds: ['r4'] }, attempts: state.attempts, results: [state.results.at(-1)] };
  card.render();
  assert.equal(card.root.querySelector('.stia-card__pager'), null, '只剩一张就没有翻看那一行');
  assert.equal(history(), '历史 1 张');
});

test('出图后的「重新生成」可以直接换预设：画这张图的「原渠道」排第一；只有一个预设或 NovelAI 时点了就画', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });

  const tag = { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' };
  const state = {
    tag: { latestResultId: 'r1', resultIds: ['r1'] },
    attempts: [{ attemptId: 'a1', status: 'succeeded', provider: 'openai', presetId: 'old', model: 'm' }],
    results: [{ resultId: 'r1', attemptId: 'a1', status: 'available', prompt: 'a cat', provider: 'openai', presetId: 'old' }],
  };
  let settings = { generationProvider: 'openai' };
  let presets = [
    { id: 'other', name: '别的组', active: false, backup: false },
    { id: 'stable', name: '稳定组', active: false, backup: true },
    { id: 'cheap', name: '纯爱二号', active: true, backup: false },
    { id: 'old', name: '老渠道', active: false, backup: false, hasApiKey: false },
  ];
  const generated = [];
  const card = createCard({
    tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    getSettings: () => settings,
    onGenerate: (...args) => generated.push(args),
    onOpenGallery() {},
    onCancel() {},
    listPresets: async () => presets,
  });
  card.render();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const buttons = () => [...card.root.querySelectorAll('.stia-card__body button:not(.stia-copy)')].map(button => button.textContent);
  const click = label => [...card.root.querySelectorAll('button')].find(button => button.textContent === label).click();

  click('重新生成');
  await settle();
  assert.match(card.root.textContent, /用哪个预设重新生成？/);
  assert.deepEqual(
    buttons(),
    ['老渠道（原渠道）（没填 Key）', '纯爱二号（当前）', '稳定组（备用）', '别的组', '算了'],
    '画这张图的原渠道第一，然后当前、备用、其他',
  );
  click('算了');
  assert.deepEqual(buttons(), ['重新生成', '原图', '画廊'], '「算了」收起');

  click('重新生成');
  await settle();
  click('稳定组（备用）');
  assert.equal(generated.length, 1);
  assert.equal(generated[0][0], tag);
  assert.equal(generated[0][1], 'manual');
  assert.equal(generated[0][2].preset.id, 'stable', '用选的预设重新生成');
  assert.deepEqual(buttons(), ['重新生成', '原图', '画廊']);

  presets = [{ id: 'old', name: '老渠道', active: true, backup: false }, { id: 'stable', name: '稳定组', active: false, backup: true }];
  click('重新生成');
  await settle();
  assert.deepEqual(buttons().slice(0, 2), ['老渠道（原渠道）', '稳定组（备用）'], '原渠道就是当前预设时只写原渠道');
  click('算了');

  presets = [{ id: 'old', name: '老渠道', active: true }];
  click('重新生成');
  await settle();
  assert.deepEqual(generated.at(-1), [tag, 'manual'], '只有一个预设：和以前一样点了就画');

  settings = { generationProvider: 'novelai' };
  click('重新生成');
  await settle();
  assert.deepEqual(generated.at(-1), [tag, 'manual'], 'NovelAI 没有 API 预设可选');
  assert.equal(generated.length, 3);
});

test('「查看提示词」展开后下面有「一键复制」：没展开时看不到，点了复制这张图的提示词', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const written = [];
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async text => { written.push(text); } } },
  });
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    dom.window.close();
  });

  let state = {
    tag: { latestResultId: 'r1', resultIds: ['r1'] },
    attempts: [{ attemptId: 'a1', status: 'succeeded' }],
    results: [{ resultId: 'r1', attemptId: 'a1', status: 'available', prompt: 'a cat in the rain\n\nNo watermark.' }],
  };
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' },
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  card.render();
  document.body.append(card.root);
  const details = card.root.querySelector('.stia-prompt');
  assert.deepEqual(
    [...details.children].map(child => child.className || child.tagName),
    ['SUMMARY', 'PRE', 'stia-copy-row'],
    '复制按钮在 details 里、提示词下面：没展开时跟着收起来',
  );
  const copy = details.querySelector('.stia-copy');
  assert.equal(copy.textContent, '一键复制');

  details.open = true;
  copy.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(written, ['a cat in the rain\n\nNo watermark.'], '复制的是这张图实际用的提示词，原样保留换行');
  assert.equal(copy.textContent, '已复制');
  card.render();
  assert.equal(card.root.querySelector('.stia-copy'), copy, '别的卡片有动静时不重建，「已复制」不会被冲掉');
  assert.equal(details.open, true);

  state = { attempts: [{ attemptId: 'a2', status: 'failed', errorMessage: 'HTTP 500', promptSnapshot: 'failed prompt' }], results: [] };
  card.render();
  card.root.querySelector('.stia-prompt .stia-copy').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(written.at(-1), 'failed prompt', '失败的卡片也能复制');
});

/* 2.5.0 出图后的卡片上「参考重画」旁边加「换预设」。 */
async function presetSwitchSetup(t, { provider = 'openai', withReference = true } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });
  const tag = { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' };
  const context = {
    dom,
    tag,
    state: {
      tag: { latestResultId: 'r1', resultIds: ['r1'] },
      attempts: [{ attemptId: 'a1', status: 'succeeded', provider, presetId: 'old', model: 'm' }],
      results: [{ resultId: 'r1', attemptId: 'a1', status: 'available', prompt: 'a cat', provider, presetId: 'old' }],
    },
    settings: { generationProvider: provider, executionMode: 'direct' },
    choices: {
      kind: provider === 'novelai' ? 'artist' : 'api',
      activeId: 'cheap',
      busy: false,
      items: [{ id: 'old', name: '走十六方' }, { id: 'cheap', name: '纯爱二号' }, { id: 'stable', name: '稳定组' }],
    },
    switched: [],
    /* 切换的结果由测试决定：默认切成，当前预设跟着变。 */
    switchResult: id => {
      context.choices = { ...context.choices, activeId: id };
      return true;
    },
  };
  context.card = createCard({
    tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => context.state,
    getSettings: () => context.settings,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
    ...(withReference ? { onReferenceRegenerate() {} } : {}),
    listPresets: async () => [],
    getPresetChoices: () => context.choices,
    onSwitchPreset: async id => {
      context.switched.push(id);
      return context.switchResult(id);
    },
  });
  context.card.render();
  context.actions = () => [...context.card.root.querySelector('.stia-actions').children];
  context.control = () => context.card.root.querySelector('.stia-card__preset');
  context.select = () => context.card.root.querySelector('.stia-card__preset-select');
  context.choose = id => {
    const select = context.select();
    select.value = id;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  context.settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return context;
}

test('出图后的卡片上「参考重画」旁边有「换预设」：写着当前预设，点开是所有预设，两个各占一半', async t => {
  const { actions, control, select } = await presetSwitchSetup(t);
  assert.deepEqual(
    actions().map(node => node.textContent),
    ['重新生成', '原图', '画廊', '参考重画', '预设：纯爱二号走十六方纯爱二号稳定组'],
    '紧跟在「参考重画」后面',
  );
  /* 2.6.0：按钮前面是画出来的线条图标，不再是 ↻ ⌕ ▦ 这类符号字符；字里不带符号，读屏只读字。 */
  assert.deepEqual(actions().map(iconOf), ['refresh', 'expand', 'grid', 'portrait', 'sliders']);
  assert.deepEqual(blankIcons(actions()[0].closest('.stia-card')), [], '用到的图标都画得出来');
  assert.ok(actions().every(node => node.querySelector('.stia-icon').getAttribute('aria-hidden') === 'true'), '图标只是装饰');
  assert.equal(actions()[1].getAttribute('aria-label'), '查看原图、保存', '「原图」两个字短，完整的意思写在 aria-label 上');
  assert.equal(control().tagName, 'LABEL', '整块都是选择框的标签：点哪儿都打开系统的选择器');
  assert.ok(control().classList.contains('stia-button'), '样子和别的按钮一样');
  assert.equal(control().querySelector('.stia-card__preset-name').textContent, '预设：纯爱二号');
  assert.deepEqual([...select().options].map(option => [option.value, option.textContent]), [
    ['old', '走十六方'], ['cheap', '纯爱二号'], ['stable', '稳定组'],
  ]);
  assert.equal(select().value, 'cheap', '选中的是当前预设，不是画这张图的那个');
  assert.equal(select().getAttribute('aria-label'), '切换当前生图预设');
  assert.equal(select().disabled, false);
  assert.ok(control().parentElement.classList.contains('stia-actions--pairs'), '两个一行：和「参考重画」各占一半');
});

test('在卡片上换预设：切的时候按钮写「正在切换…」、点不动，切完写上新的；别的卡片跟着变', async t => {
  const context = await presetSwitchSetup(t);
  const { card, control, select, choose, settle } = context;
  let finish;
  context.switchResult = id => new Promise(resolve => {
    finish = () => {
      context.choices = { ...context.choices, activeId: id };
      resolve(true);
    };
  });

  choose('stable');
  await settle();
  assert.deepEqual(context.switched, ['stable']);
  assert.equal(control().querySelector('.stia-card__preset-name').textContent, '正在切换…');
  assert.equal(select().disabled, true);
  assert.ok(control().classList.contains('is-busy'));

  finish();
  await settle();
  assert.equal(control().querySelector('.stia-card__preset-name').textContent, '预设：稳定组');
  assert.equal(select().value, 'stable');
  assert.equal(select().disabled, false);
  assert.equal(control().classList.contains('is-busy'), false);

  /* 在别处（另一张卡、设置页）换了：这张卡下次重画时跟着变。 */
  const before = control();
  context.choices = { ...context.choices, activeId: 'old' };
  card.render();
  assert.equal(control().querySelector('.stia-card__preset-name').textContent, '预设：走十六方');
  assert.notEqual(control(), before);
  /* 什么都没变就不重建。 */
  const same = control();
  card.render();
  assert.equal(control(), same);

  /* 选回当前这个：什么都不做。 */
  choose('old');
  await settle();
  assert.deepEqual(context.switched, ['stable']);
});

test('换预设没成功（保存失败、切换失败）：选择框回到原来那个，卡片不会停在「正在切换」', async t => {
  const context = await presetSwitchSetup(t);
  const { control, select, choose, settle } = context;
  context.switchResult = () => false;
  choose('stable');
  await settle();
  assert.equal(select().value, 'cheap');
  assert.equal(control().querySelector('.stia-card__preset-name').textContent, '预设：纯爱二号');

  context.switchResult = () => { throw new Error('boom'); };
  choose('old');
  await settle();
  assert.equal(select().value, 'cheap', '抛错也一样');
  assert.equal(select().disabled, false);
  assert.deepEqual(context.switched, ['stable', 'old']);
});

test('设置面板正忙着（正在保存、正在切）：卡片上的「换预设」点不动', async t => {
  const context = await presetSwitchSetup(t);
  context.choices = { ...context.choices, busy: true };
  context.card.render();
  assert.equal(context.select().disabled, true);
  assert.ok(context.control().classList.contains('is-busy'));
  assert.equal(context.control().querySelector('.stia-card__preset-name').textContent, '预设：纯爱二号');
});

test('只有一个预设、没接上切换、等待生成和正在画的卡片：不显示「换预设」', async t => {
  const context = await presetSwitchSetup(t);
  const { card, control, actions } = context;
  context.choices = { ...context.choices, items: [{ id: 'cheap', name: '纯爱二号' }] };
  card.render();
  assert.equal(control(), null, '只有一个预设没什么可换的');
  assert.deepEqual(actions().map(node => node.textContent), ['重新生成', '原图', '画廊', '参考重画']);

  context.choices = null;
  card.render();
  assert.equal(control(), null, '面板还没准备好');

  context.choices = { kind: 'api', activeId: 'cheap', busy: false, items: [{ id: 'old', name: '走十六方' }, { id: 'cheap', name: '纯爱二号' }] };
  context.state = { tag: {}, attempts: [], results: [] };
  card.render();
  assert.equal(control(), null, '等待生成的卡片上没有');
  context.state = { tag: {}, attempts: [{ attemptId: 'a3', status: 'generating', provider: 'openai' }], results: [] };
  card.render();
  assert.equal(control(), null, '正在画的卡片上没有');

  const plain = createCard({
    tag: context.tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => ({
      tag: { latestResultId: 'r1' },
      attempts: [],
      results: [{ resultId: 'r1', status: 'available', prompt: 'a cat', provider: 'openai' }],
    }),
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  plain.render();
  assert.equal(plain.root.querySelector('.stia-card__preset'), null, '没传这两个依赖就没有');
});

test('NovelAI：没有「参考重画」，「换预设」换的是画师串，自己占一行', async t => {
  const { actions, control, select } = await presetSwitchSetup(t, { provider: 'novelai' });
  assert.deepEqual(
    actions().map(node => node.textContent.replace(/走十六方纯爱二号稳定组$/, '')),
    ['重新生成', '原图', '画廊', '画师串：纯爱二号'],
  );
  assert.equal(select().getAttribute('aria-label'), '切换当前画师串预设');
  assert.ok(control().parentElement.classList.contains('stia-actions--pairs'));
});

/* 2.5.1 失败的卡片上也有「换预设」。 */
test('失败、被中断、已取消的卡片上也有「换预设」：只换预设，不替人重试；换完点「重试」才画', async t => {
  const context = await presetSwitchSetup(t);
  const { tag, settle } = context;
  const generated = [];
  const removed = [];
  const failing = createCard({
    tag,
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => context.state,
    getSettings: () => context.settings,
    onGenerate: (...args) => { generated.push(args); },
    onOpenGallery() {},
    onCancel() {},
    onRemove: item => removed.push(item),
    onFallback() {},
    onAdjustRegenerate() {},
    listPresets: async () => [],
    getPresetChoices: () => context.choices,
    onSwitchPreset: async id => {
      context.switched.push(id);
      context.choices = { ...context.choices, activeId: id };
      return true;
    },
  });
  const row = () => [...failing.root.querySelector('.stia-actions').children];
  const labels = () => row().map(node => node.textContent.replace(/走十六方纯爱二号稳定组$/, ''));
  const failedControl = () => failing.root.querySelector('.stia-card__preset');
  const pick = id => {
    const element = failing.root.querySelector('.stia-card__preset-select');
    element.value = id;
    element.dispatchEvent(new context.dom.window.Event('change', { bubbles: true }));
  };

  for (const [status, title] of [['failed', '生成失败'], ['interrupted', '生成被中断'], ['cancelled', '已取消']]) {
    context.state = { tag: {}, attempts: [{ attemptId: `a-${status}`, status, provider: 'openai', presetId: 'cheap', errorMessage: '上游超时' }], results: [] };
    failing.render();
    assert.match(failing.root.textContent, new RegExp(title));
    assert.deepEqual(labels(), ['重试', '预设：纯爱二号', '删除'], `${title}的卡片上有`);
    /* 失败、中断是警告三角，自己取消的是个叉。 */
    assert.equal(iconOf(failing.root.querySelector('.stia-card__status')), status === 'cancelled' ? 'close' : 'alert');
    assert.deepEqual(blankIcons(failing.root), []);
    assert.equal(row()[1], failedControl());
    assert.equal(failedControl().parentElement.classList.contains('stia-actions--pairs'), false, '三个按钮排一行');
  }

  pick('stable');
  await settle();
  assert.deepEqual(context.switched, ['stable']);
  assert.deepEqual(generated, [], '换预设不会自己去重试：重试要花钱，得自己点');
  assert.deepEqual(labels(), ['重试', '预设：稳定组', '删除'], '按钮写上新的预设');

  [...failing.root.querySelectorAll('button')].find(button => button.textContent === '重试').click();
  assert.deepEqual(generated, [[tag, 'manual']], '点「重试」才画，用的是当前预设');

  /* 设了备用线路、开了「调整后重绘」：换备用线路在前，换预设跟在后面，两个一行。 */
  context.settings = { generationProvider: 'openai', executionMode: 'direct', backupPresetId: 'old', enablePromptOverrideRegenerate: true };
  context.state = { tag: {}, attempts: [{ attemptId: 'a-again', status: 'failed', provider: 'openai', presetId: 'stable', errorMessage: '上游超时' }], results: [] };
  failing.render();
  assert.deepEqual(labels(), ['重试', '换备用线路', '预设：稳定组', '调整后重绘', '删除']);
  assert.deepEqual(
    [...failing.root.querySelectorAll('.stia-actions > *')].map(iconOf),
    ['refresh', 'swap', 'sliders', 'pencil', 'trash'],
  );
  assert.deepEqual(blankIcons(failing.root), []);
  assert.ok(failedControl().parentElement.classList.contains('stia-actions--pairs'));

  /* 只有一个预设：没有。 */
  context.choices = { ...context.choices, items: [{ id: 'stable', name: '稳定组' }] };
  failing.render();
  assert.equal(failedControl(), null);
  assert.equal(removed.length, 0);
});

test('2.7.0 卡片上点开原图后也能左右翻这张卡的几张图：提示词、模型跟着换；关掉后卡片停在最后看的那张上', async t => {
  const { JSDOM } = await import('jsdom');
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

  const attemptFor = (id, model) => ({
    attemptId: id, status: 'succeeded', provider: 'openai', model, presetNameSnapshot: '纯爱二号', parameters: { size: '1024x1792' },
    createdAt: '2026-10-05T01:00:00.000Z', completedAt: '2026-10-05T01:02:00.000Z',
  });
  const resultFor = (id, attemptId, prompt, model) => ({ resultId: id, attemptId, status: 'available', prompt, provider: 'openai', apiModel: model });
  let state = {
    tag: { latestResultId: 'r3', resultIds: ['r1', 'r2', 'r3'] },
    attempts: [attemptFor('a3', 'model-c'), attemptFor('a2', 'model-b'), attemptFor('a1', 'model-a')],
    results: [resultFor('r1', 'a1', '第一版', 'model-a'), resultFor('r2', 'a2', '第二版', 'model-b'), resultFor('r3', 'a3', '第三版', 'model-c')],
  };
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' },
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  card.render();
  document.body.append(card.root);
  const cardSrc = () => card.root.querySelector('.stia-card__image').getAttribute('src');
  const counter = () => card.root.querySelector('.stia-card__pager-count').textContent;
  const viewer = () => document.querySelector('.stia-image-viewer');
  const title = () => viewer().querySelector('.stia-image-viewer__toolbar strong').textContent;
  const shown = () => viewer().querySelector('.stia-image-viewer__image').getAttribute('src');
  const arrow = name => viewer().querySelector(`.stia-image-viewer__nav.${name}`);

  /* 点开没翻就关：卡片当作没发生过。不能因此把另外两张原图也先载上（手机上是白花的流量）。 */
  card.root.querySelector('.stia-card__image').click();
  viewer().querySelector('.stia-image-viewer__close').click();
  const created = [];
  const createElement = document.createElement.bind(document);
  document.createElement = (name, ...rest) => {
    if (String(name).toLowerCase() === 'img') created.push(name);
    return createElement(name, ...rest);
  };
  state = { ...state, attempts: [{ ...state.attempts[0], statusMessage: '变了一下' }, ...state.attempts.slice(1)] };
  card.render();
  document.createElement = createElement;
  assert.deepEqual(created, [], '重画时没有去载别的图');
  assert.equal(cardSrc(), '/user/images/r3.png');

  /* 点卡片上的图：打开的是最新那张，写着是 3 张里的第 3 张。 */
  card.root.querySelector('.stia-card__image').click();
  assert.equal(title(), '3 / 3');
  assert.equal(shown(), '/user/images/r3.png');
  assert.match(viewer().querySelector('.stia-image-viewer__meta').textContent, /model-c/);
  assert.equal(arrow('is-next').hidden, true);

  arrow('is-prev').click();
  assert.equal(title(), '2 / 3');
  assert.equal(shown(), '/user/images/r2.png');
  assert.match(viewer().querySelector('.stia-image-viewer__meta').textContent, /model-b/, '模型是这一张的');
  assert.equal(viewer().querySelector('.stia-image-viewer__prompt pre').textContent, '第二版', '提示词是这一张的');
  arrow('is-prev').click();
  assert.equal(shown(), '/user/images/r1.png');
  assert.equal(arrow('is-prev').hidden, true);
  assert.equal(cardSrc(), '/user/images/r3.png', '看图器开着时卡片不动');

  /* 关掉：卡片停在最后看的那张上，信息、翻看的数字都跟着。 */
  viewer().querySelector('.stia-image-viewer__close').click();
  assert.equal(viewer(), null);
  assert.equal(cardSrc(), '/user/images/r1.png');
  assert.equal(counter(), '1 / 3');

  /* 没翻就关：卡片不重画。 */
  const before = card.root.querySelector('.stia-card__image');
  before.click();
  assert.equal(title(), '1 / 3');
  viewer().querySelector('.stia-image-viewer__close').click();
  assert.equal(card.root.querySelector('.stia-card__image'), before);
  assert.equal(counter(), '1 / 3');

  /* 只有一张图的卡片：没有箭头。 */
  state = { tag: { latestResultId: 'r3', resultIds: ['r3'] }, attempts: [attemptFor('a3', 'model-c')], results: [resultFor('r3', 'a3', '第三版', 'model-c')] };
  card.render();
  card.root.querySelector('.stia-card__image').click();
  assert.equal(title(), '查看原图');
  assert.equal(arrow('is-prev').hidden, true);
  assert.equal(arrow('is-next').hidden, true);
  viewer().querySelector('.stia-image-viewer__close').click();
});

test('2.9.0 图画好了却没存进酒馆（线路只给了链接）：失败的卡片直接从链接把图显示出来，写明长按能存、链接会失效、重画要再花钱；点开能看大图；链接打不开时说清楚', async t => {
  const { JSDOM } = await import('jsdom');
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
  /* 这台「手机」有系统分享：看图器里的「分享、保存」要先把图下载下来，这张下载不了，所以不给。 */
  Object.defineProperty(dom.window.navigator, 'share', { configurable: true, value: async () => {} });

  const link = 'https://img.cdn.example/private/a.png?sig=SIGNED';
  const reason = '生图成功了，但这条线路没按要求把图片本身传回来，只给了一个链接（在 img.cdn.example 上），浏览器下载不了它。';
  const failed = extra => ({ attemptId: 'a1', status: 'failed', provider: 'openai', presetId: 'p1', model: 'gpt-image-2.5-sunburst-4k', errorCode: 'DIRECT_FETCH_BLOCKED', errorMessage: reason, ...extra });
  let state = { tag: {}, attempts: [failed({ remoteImages: [link] })], results: [] };
  const generated = [];
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'a cat', ratio: 'portrait' },
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate: (tag, mode) => { generated.push([tag.tagId, mode]); },
    onOpenGallery() {},
    onCancel() {},
    onRemove() {},
  });
  card.render();
  document.body.append(card.root);
  const root = card.root;
  const image = () => root.querySelector('.stia-card__media--remote img');
  const labels = () => [...root.querySelectorAll('.stia-actions > *')].map(node => node.textContent);

  /* 图直接从链接显示；不带来源页地址（有的图床看到别的网站来要图会拒绝）。 */
  assert.ok(root.classList.contains('stia-card--failed'));
  assert.ok(root.classList.contains('stia-card--salvaged'));
  assert.equal(image().getAttribute('src'), link);
  assert.equal(image().getAttribute('referrerpolicy'), 'no-referrer');
  assert.ok(image().classList.contains('stia-saveable-image'), '长按保存的菜单不拦');
  assert.equal(root.querySelector('.stia-card__media').nextElementSibling.className, 'stia-card__body', '图在上，说明和按钮在下');

  /* 说清楚：图是有的、怎么留、会过期、重画要再花钱。 */
  const heading = root.querySelector('.stia-card__status');
  assert.ok(heading.classList.contains('is-warning'), '不是红的「生成失败」');
  assert.equal(heading.querySelector('strong').textContent, '图画好了，没能存进酒馆');
  assert.match(heading.textContent, /长按图片可以存到相册/);
  assert.match(heading.textContent, /链接过一阵会失效/);
  assert.match(root.textContent, /再画一张会再扣一次钱/);
  assert.equal(iconOf(heading), 'alert');
  /* 原因收在下面，点开才看。 */
  const why = root.querySelector('.stia-card__salvage-reason');
  assert.equal(why.tagName, 'DETAILS');
  assert.equal(why.open, false);
  assert.equal(why.querySelector('summary').textContent, '为什么没存进酒馆');
  assert.match(why.textContent, /没按要求把图片本身传回来/);

  /* 按钮：打开链接、重新画一张（就是原来的重试）、删除。 */
  assert.deepEqual(labels(), ['打开图片链接', '重新画一张', '删除']);
  const open = root.querySelector('.stia-actions > a');
  assert.equal(open.getAttribute('href'), link);
  assert.equal(open.getAttribute('target'), '_blank');
  assert.deepEqual(open.getAttribute('rel').split(' ').sort(), ['noopener', 'noreferrer']);
  assert.equal(iconOf(open), 'expand');
  assert.deepEqual(blankIcons(root), []);
  [...root.querySelectorAll('button')].find(node => node.textContent === '重新画一张').click();
  assert.deepEqual(generated, [['tag-1', 'manual']]);

  /* 点图片：看图器里放大看、长按存。不给「分享、保存」。 */
  image().click();
  const viewer = () => document.querySelector('.stia-image-viewer');
  assert.equal(viewer().querySelector('.stia-image-viewer__image').getAttribute('src'), link);
  assert.match(viewer().querySelector('.stia-image-viewer__meta').textContent, /线路给的临时链接/);
  assert.equal([...viewer().querySelectorAll('button')].some(node => node.textContent === '分享、保存'), false);
  viewer().querySelector('.stia-image-viewer__close').click();

  /* 别的原因重画卡片：图片元素还是那个，不重新加载。 */
  const kept = image();
  state = { ...state, attempts: [failed({ remoteImages: [link], statusMessage: '变了一下' })] };
  card.render();
  assert.equal(image(), kept);

  /* 链接打不开了（过期、这台设备连不上那台主机）：换成一句话，打开链接的键还在。重画卡片也不再去试。 */
  image().dispatchEvent(new dom.window.Event('error'));
  assert.equal(image(), null);
  assert.match(root.querySelector('.stia-card__media--remote').textContent, /这个链接现在打不开/);
  assert.ok(root.querySelector('.stia-actions > a'));
  /* 图显示不出来了，说明也跟着改：不能还写着「上面这张……长按可以存」。 */
  const subtitle = () => root.querySelector('.stia-card__status small').textContent;
  assert.match(subtitle(), /图显示不出来/);
  assert.equal(/长按图片可以存到相册/.test(subtitle()), false);
  assert.match(subtitle(), /再画一张会再扣一次钱/);
  state = { ...state, attempts: [failed({ remoteImages: [link], statusMessage: '又变了一下' })] };
  card.render();
  assert.equal(image(), null);
  assert.match(root.querySelector('.stia-card__media--remote').textContent, /这个链接现在打不开/);
  assert.match(subtitle(), /图显示不出来/, '重画卡片后还是这么说');

  /* 好几张：都显示，各有各的打开键。 */
  state = { tag: {}, attempts: [failed({ attemptId: 'a2', remoteImages: ['https://img.cdn.example/1.png', 'https://img.cdn.example/2.png'] })], results: [] };
  card.render();
  assert.deepEqual([...root.querySelectorAll('.stia-card__media--remote img')].map(node => node.getAttribute('src')), ['https://img.cdn.example/1.png', 'https://img.cdn.example/2.png']);
  assert.deepEqual(labels(), ['打开第 1 张', '打开第 2 张', '重新画一张', '删除']);
  /* 两张里坏了一张：另一张还看得到，说明照旧。 */
  root.querySelector('.stia-card__media--remote img').dispatchEvent(new dom.window.Event('error'));
  assert.equal(root.querySelectorAll('.stia-card__media--remote img').length, 1);
  assert.match(subtitle(), /长按图片可以存到相册/);

  /* 没有链接的失败、不是 http(s) 的东西、被中断的：照旧是普通的失败卡片。 */
  for (const attempt of [
    failed({ attemptId: 'a3' }),
    failed({ attemptId: 'a4', remoteImages: ['javascript:alert(1)', 'data:image/png;base64,AAAA', 42, ''] }),
    failed({ attemptId: 'a5', status: 'interrupted', remoteImages: [link] }),
  ]) {
    state = { tag: {}, attempts: [attempt], results: [] };
    card.render();
    assert.equal(root.querySelector('.stia-card__media--remote'), null, attempt.attemptId);
    assert.equal(root.classList.contains('stia-card--salvaged'), false, attempt.attemptId);
    assert.equal(labels()[0], '重试', attempt.attemptId);
  }
});

test('2.10.0 图片淡入：没载好时带 is-arriving（透明），载好或载不出来就去掉；已经载好的图不闪', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });
  /* 第二张图当成「已经在缓存里、一创建就是载好的」。 */
  const createElement = document.createElement.bind(document);
  let complete = false;
  document.createElement = (name, ...rest) => {
    const node = createElement(name, ...rest);
    if (String(name).toLowerCase() === 'img') Object.defineProperty(node, 'complete', { configurable: true, get: () => complete });
    return node;
  };
  const stateFor = id => ({
    tag: { latestResultId: id, resultIds: [id] },
    attempts: [{ attemptId: `a-${id}`, status: 'succeeded', provider: 'openai', createdAt: '2026-10-05T01:00:00.000Z', completedAt: '2026-10-05T01:02:00.000Z' }],
    results: [{ resultId: id, attemptId: `a-${id}`, status: 'available', prompt: 'cat', provider: 'openai' }],
  });
  let state = stateFor('r1');
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'cat' },
    api: { fileUrl: id => `/user/images/${id}.png` },
    getState: () => state,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
  });
  card.render();
  const image = () => card.root.querySelector('.stia-card__image');
  assert.ok(image().classList.contains('is-arriving'), '还没载好：透明着');
  image().dispatchEvent(new dom.window.Event('load'));
  assert.equal(image().classList.contains('is-arriving'), false, '载好了：淡进来');

  state = stateFor('r2');
  card.render();
  assert.ok(image().classList.contains('is-arriving'));
  image().dispatchEvent(new dom.window.Event('error'));
  assert.equal(image().classList.contains('is-arriving'), false, '载不出来也不能一直透明');

  complete = true;
  state = stateFor('r3');
  card.render();
  assert.equal(image().getAttribute('src'), '/user/images/r3.png');
  assert.equal(image().classList.contains('is-arriving'), false, '已经载好的不闪一下');
});
