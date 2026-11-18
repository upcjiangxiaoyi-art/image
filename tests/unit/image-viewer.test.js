import test from 'node:test';
import assert from 'node:assert/strict';
import { makeImageSaveable, openImageViewer } from '../../src/ui/media/image-viewer.js';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }

  remove(...values) {
    values.forEach(value => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = { overflow: '' };
    this.textContent = '';
    this.className = '';
    this.disabled = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  prepend(...children) {
    for (const child of children.reverse()) {
      child.parentElement = this;
      this.children.unshift(child);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event });
  }

  focus() {
    this.focused = true;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
}

function fakeEnvironment() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  const previousFocus = new FakeElement('button');
  const document = {
    body,
    documentElement,
    activeElement: previousFocus,
    createElement: tagName => new FakeElement(tagName),
  };
  const listeners = new Map();
  const previousState = { page: 'chat' };
  const history = {
    state: previousState,
    backCalls: 0,
    pushState(state) {
      this.state = state;
    },
    back() {
      this.backCalls += 1;
      this.state = previousState;
    },
  };
  const window = {
    history,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
  return { document, window, navigator: {}, previousFocus };
}

test('原图查看器始终提供关闭按钮，关闭后返回聊天历史状态', () => {
  const environment = fakeEnvironment();
  const viewer = openImageViewer({ src: '/user/images/a.png', alt: '测试图片' }, environment);
  const toolbar = viewer.root.children[0];
  const close = toolbar.children[1];

  assert.equal(viewer.root.attributes.get('role'), 'dialog');
  assert.equal(close.attributes.get('aria-label'), '关闭原图并返回酒馆页面');
  assert.equal(environment.document.body.style.overflow, 'hidden');
  assert.equal(environment.document.body.children.includes(viewer.root), true);

  close.dispatch('click');
  assert.equal(environment.document.body.children.includes(viewer.root), false);
  assert.equal(environment.window.history.backCalls, 1);
  assert.equal(environment.document.body.style.overflow, '');
  assert.equal(environment.previousFocus.focused, true);
});

test('手机返回事件关闭查看器，图片没有拦截长按菜单', () => {
  const environment = fakeEnvironment();
  const image = new FakeElement('img');
  let opens = 0;
  makeImageSaveable(image, () => { opens += 1; });
  assert.equal(image.classList.contains('stia-saveable-image'), true);
  assert.equal(image.listeners.has('contextmenu'), false);
  assert.equal(image.listeners.has('touchstart'), false);
  image.dispatch('click');
  assert.equal(opens, 1);

  const viewer = openImageViewer({ src: '/user/images/b.png' }, environment);
  environment.window.dispatch('popstate');
  assert.equal(environment.document.body.children.includes(viewer.root), false);
  assert.equal(environment.window.history.backCalls, 0);
});

test('原图查看层的「查看提示词」展开后也有「一键复制」', async () => {
  const environment = fakeEnvironment();
  const written = [];
  environment.navigator = { clipboard: { writeText: async text => { written.push(text); } } };
  const viewer = openImageViewer({ src: '/user/images/c.png', prompt: 'a cat in the rain' }, environment);
  const all = element => [element, ...element.children.flatMap(all)];
  const details = all(viewer.root).find(element => element.className === 'stia-image-viewer__prompt');
  assert.deepEqual(details.children.map(child => child.className || child.tagName), ['summary', 'pre', 'stia-copy-row']);
  const copy = details.children[2].children[0];
  assert.equal(copy.textContent, '一键复制');

  copy.dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(written, ['a cat in the rain']);
  assert.equal(copy.textContent, '已复制');
  viewer.destroy();
});

test('2.6.0 看图器：打开时整张图放进屏幕，点一下图片放大、再点一下回来；底下一排按钮最后是「关闭」', () => {
  const environment = fakeEnvironment();
  environment.navigator = { share: async () => {} };
  const viewer = openImageViewer({
    src: '/user/images/d.png',
    meta: 'gpt-image · 1024×1792',
    onJump: async () => true,
    onDelete: async () => true,
  }, { ...environment, fetch: async () => ({ ok: true, blob: async () => ({ type: 'image/png' }) }), File: class {} });
  const [toolbar, stage, footer] = viewer.root.children;
  assert.equal(stage.className, 'stia-image-viewer__stage');
  assert.equal(stage.classList.contains('is-zoomed'), false, '打开时是整张');
  viewer.image.dispatch('click');
  assert.equal(stage.classList.contains('is-zoomed'), true, '点一下放大');
  viewer.image.dispatch('click');
  assert.equal(stage.classList.contains('is-zoomed'), false, '再点一下回来');
  assert.equal(viewer.image.listeners.has('contextmenu'), false, '长按保存的菜单没被拦');

  /* 底下：信息、状态、一排按钮、最后一句小字。 */
  assert.deepEqual(footer.children.map(child => child.className), [
    'stia-image-viewer__meta',
    'stia-image-viewer__status',
    'stia-image-viewer__actions',
    'stia-image-viewer__hint',
  ]);
  assert.equal(footer.children.at(-1).textContent, '点一下图片放大，长按图片保存');
  const actions = footer.children[2].children;
  assert.deepEqual(actions.map(button => button.textContent), ['分享、保存', '跳到所在楼层', '删除', '关闭']);
  assert.equal(actions.at(-1).attributes.get('aria-label'), '关闭原图并返回酒馆页面');
  assert.equal(toolbar.children[1].textContent, '关闭');

  actions.at(-1).dispatch('click');
  assert.equal(environment.document.body.children.includes(viewer.root), false, '底下的「关闭」也关得掉');
});
