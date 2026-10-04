import test from 'node:test';
import assert from 'node:assert/strict';
import { createCard, formatDuration, formatElapsed, generationDuration, imageInfo } from '../../src/ui/renderer/card.js';

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
  assert.match(card.root.textContent, /历史 2 张/, '历史张数变了就更新');
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

  assert.deepEqual(buttons(), ['↻再画一张', '×取消']);
  click('↻再画一张');
  await settle();
  assert.match(card.root.textContent, /这张会在后台接着画。用哪个预设再画一张？/);
  assert.deepEqual(buttons(), ['便宜组（当前）', '快速组', '新预设（没填 Key）', '算了']);
  click('算了');
  assert.deepEqual(buttons(), ['↻再画一张', '×取消'], '「算了」收起');

  click('↻再画一张');
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
  assert.equal(buttons().includes('×删除'), false, '后台还在画时不给删除');

  settings = { generationProvider: 'novelai' };
  state = { attempts: [{ attemptId: 'nai', status: 'generating', requestMode: 'manual' }], results: [] };
  card.render();
  click('↻再画一张');
  await settle();
  assert.deepEqual(buttons(), ['↻确定再画一张', '算了'], 'NovelAI 没有 API 预设可选，确认一下就画');
  click('↻确定再画一张');
  assert.deepEqual(rerolls.at(-1).slice(1), ['nai', undefined]);

  state = { attempts: [{ attemptId: 'auto:tag-1', status: 'queued', requestMode: 'auto' }], results: [] };
  card.render();
  assert.deepEqual(buttons(), ['×取消排队'], '自动排队时还没开始画，没有「再画一张」');
});

test('出图后图片右上角显示这张图用了多久；记录不全时不显示', async t => {
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
  const badge = () => card.root.querySelector('.stia-card__media .stia-card__duration');
  assert.equal(badge().textContent, '用时 16 分 37 秒');
  assert.equal(card.root.querySelector('.stia-card__size').textContent, '1024×1792', '尺寸角标照旧在');

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
    presetLabel: '预设', preset: '纯爱2.5', model: 'gpt-image-2.5-sunburst', quality: 'max', size: '1024×1792',
  });
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

  state = { ...state, attempts: [], results: [{ resultId: 'r1', status: 'available', prompt: 'a cat' }] };
  card.render();
  assert.equal(card.root.querySelector('.stia-card__info'), null, '老图片什么记录都没有就不显示这一块');
});
