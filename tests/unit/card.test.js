import test from 'node:test';
import assert from 'node:assert/strict';
import { createCard } from '../../src/ui/renderer/card.js';

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
