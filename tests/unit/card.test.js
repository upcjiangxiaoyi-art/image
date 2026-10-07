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
  assert.equal(card.root.querySelector('.stia-card__completion-status').textContent, '✓ 已完成用时 16 分 37 秒');
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
  assert.deepEqual(buttons(), ['↻重试', '⇄换备用线路', '×删除']);
  [...card.root.querySelectorAll('button')].find(button => button.textContent === '⇄换备用线路').click();
  assert.deepEqual(fallbacks, [tag]);

  const without = expected => {
    card.render();
    assert.equal(buttons().includes('⇄换备用线路'), false, expected);
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
  [...card.root.querySelectorAll('button')].find(button => button.textContent === '↻再画一张').click();
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
  const pagerButton = label => [...card.root.querySelectorAll('.stia-card__pager button')]
    .find(item => item.textContent.endsWith(label));
  const click = label => pagerButton(label).click();

  assert.equal(shownSrc(), '/user/images/r3.png', '先显示最新那张');
  assert.equal(counter(), '3 / 3');
  assert.deepEqual(
    [...card.root.querySelectorAll('.stia-card__pager > *')].map(item => item.textContent),
    ['‹上一张', '3 / 3', '›下一张'],
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
  bodyButton('↻重新生成').click();
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

  click('↻重新生成');
  await settle();
  assert.match(card.root.textContent, /用哪个预设重新生成？/);
  assert.deepEqual(
    buttons(),
    ['老渠道（原渠道）（没填 Key）', '纯爱二号（当前）', '稳定组（备用）', '别的组', '算了'],
    '画这张图的原渠道第一，然后当前、备用、其他',
  );
  click('算了');
  assert.deepEqual(buttons(), ['↻重新生成', '⌕查看 / 保存', '▦画廊'], '「算了」收起');

  click('↻重新生成');
  await settle();
  click('稳定组（备用）');
  assert.equal(generated.length, 1);
  assert.equal(generated[0][0], tag);
  assert.equal(generated[0][1], 'manual');
  assert.equal(generated[0][2].preset.id, 'stable', '用选的预设重新生成');
  assert.deepEqual(buttons(), ['↻重新生成', '⌕查看 / 保存', '▦画廊']);

  presets = [{ id: 'old', name: '老渠道', active: true, backup: false }, { id: 'stable', name: '稳定组', active: false, backup: true }];
  click('↻重新生成');
  await settle();
  assert.deepEqual(buttons().slice(0, 2), ['老渠道（原渠道）', '稳定组（备用）'], '原渠道就是当前预设时只写原渠道');
  click('算了');

  presets = [{ id: 'old', name: '老渠道', active: true }];
  click('↻重新生成');
  await settle();
  assert.deepEqual(generated.at(-1), [tag, 'manual'], '只有一个预设：和以前一样点了就画');

  settings = { generationProvider: 'novelai' };
  click('↻重新生成');
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
  assert.equal(copy.textContent, '✓ 已复制');
  card.render();
  assert.equal(card.root.querySelector('.stia-copy'), copy, '别的卡片有动静时不重建，「✓ 已复制」不会被冲掉');
  assert.equal(details.open, true);

  state = { attempts: [{ attemptId: 'a2', status: 'failed', errorMessage: 'HTTP 500', promptSnapshot: 'failed prompt' }], results: [] };
  card.render();
  card.root.querySelector('.stia-prompt .stia-copy').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(written.at(-1), 'failed prompt', '失败的卡片也能复制');
});
