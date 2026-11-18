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
  const [toolbar, body, footer] = viewer.root.children;
  const stage = body.children[0];
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

/* 2.7.0 左右翻图用的：一串图，每张的 neighbor / position 都按 list 现在的样子现算（删掉一张后也对）。 */
function sequenceOf(list, log = []) {
  const optionsFor = entry => ({
    src: `/user/images/${entry}.png`,
    alt: entry,
    filename: entry,
    meta: `这是 ${entry}`,
    prompt: `prompt of ${entry}`,
    position: () => {
      const index = list.indexOf(entry);
      return index < 0 ? null : { index, total: list.length };
    },
    neighbor: delta => {
      const index = list.indexOf(entry);
      const target = index < 0 ? undefined : list[index + delta];
      return target ? optionsFor(target) : null;
    },
    onDelete: async () => {
      log.push(`delete ${entry}`);
      list.splice(list.indexOf(entry), 1);
      return true;
    },
    onClose: () => log.push(`close ${entry}`),
  });
  return optionsFor;
}

const everything = element => [element, ...element.children.flatMap(everything)];
const byClass = (root, name) => everything(root).find(element => String(element.className).split(' ').includes(name));
const swipe = (target, from, to) => {
  target.dispatch('touchstart', { touches: [{ clientX: from[0], clientY: from[1] }] });
  target.dispatch('touchend', { changedTouches: [{ clientX: to[0], clientY: to[1] }] });
};

test('2.7.0 看图器里左右翻图：点箭头、按方向键、左右滑都行；标题写第几张，到头了那边的箭头收起；底下的信息跟着换', () => {
  const environment = fakeEnvironment();
  const list = ['a', 'b', 'c'];
  const viewer = openImageViewer(sequenceOf(list)('b'), environment);
  const title = () => viewer.root.children[0].children[0].textContent;
  const body = byClass(viewer.root, 'stia-image-viewer__body');
  const stage = byClass(viewer.root, 'stia-image-viewer__stage');
  const previous = byClass(viewer.root, 'is-prev');
  const next = byClass(viewer.root, 'is-next');
  const meta = () => byClass(viewer.root, 'stia-image-viewer__meta').textContent;
  const hint = () => byClass(viewer.root, 'stia-image-viewer__hint').textContent;
  const shown = () => viewer.image.src;

  assert.equal(viewer.root.children[1], body, '图片那一块在顶栏和底栏中间');
  assert.deepEqual(body.children.map(child => child.className.split(' ')[0]), ['stia-image-viewer__stage', 'stia-image-viewer__nav', 'stia-image-viewer__nav']);
  assert.equal(previous.attributes.get('aria-label'), '上一张');
  assert.equal(next.attributes.get('aria-label'), '下一张');
  assert.equal(title(), '2 / 3');
  assert.equal(shown(), '/user/images/b.png');
  assert.equal(Boolean(previous.hidden), false);
  assert.equal(Boolean(next.hidden), false);
  assert.match(hint(), /左右滑/);

  /* 点箭头。 */
  next.dispatch('click');
  assert.equal(shown(), '/user/images/c.png');
  assert.equal(viewer.image.alt, 'c');
  assert.equal(title(), '3 / 3');
  assert.equal(meta(), '这是 c', '底下的信息换成这一张的');
  assert.equal(next.hidden, true, '最后一张：没有下一张');
  assert.equal(Boolean(previous.hidden), false);
  next.dispatch('click');
  assert.equal(shown(), '/user/images/c.png', '到头了不绕回去');

  /* 方向键。 */
  environment.window.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(shown(), '/user/images/b.png');
  environment.window.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(shown(), '/user/images/a.png');
  assert.equal(title(), '1 / 3');
  assert.equal(previous.hidden, true);
  assert.equal(next.hidden, false);
  environment.window.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(shown(), '/user/images/b.png');

  /* 手指往左滑是下一张，往右滑是上一张。 */
  swipe(body, [300, 400], [120, 410]);
  assert.equal(shown(), '/user/images/c.png');
  swipe(body, [100, 400], [290, 380]);
  assert.equal(shown(), '/user/images/b.png');
  /* 动得太少（是点，不是滑）、主要是上下动的：不翻。 */
  swipe(body, [300, 400], [270, 400]);
  swipe(body, [300, 200], [220, 500]);
  assert.equal(shown(), '/user/images/b.png');
  /* 两根手指（捏合缩放）：不翻。 */
  body.dispatch('touchstart', { touches: [{ clientX: 300, clientY: 400 }, { clientX: 100, clientY: 400 }] });
  body.dispatch('touchend', { changedTouches: [{ clientX: 60, clientY: 400 }] });
  assert.equal(shown(), '/user/images/b.png');

  /* 放大着的时候在上下滑着看，左右滑不翻；点箭头翻过去，新的一张回到整张。 */
  viewer.image.dispatch('click');
  assert.equal(stage.classList.contains('is-zoomed'), true);
  swipe(body, [300, 400], [100, 400]);
  assert.equal(shown(), '/user/images/b.png');
  next.dispatch('click');
  assert.equal(shown(), '/user/images/c.png');
  assert.equal(stage.classList.contains('is-zoomed'), false);

  /* 换图时旧图先淡下去，新图载好了再亮起来。 */
  assert.equal(viewer.image.classList.contains('is-loading'), true);
  viewer.image.dispatch('load');
  assert.equal(viewer.image.classList.contains('is-loading'), false);
  viewer.destroy();
});

test('2.7.0 只有一张图时：没有箭头，标题还是「查看原图」，滑、按方向键都没反应', () => {
  const environment = fakeEnvironment();
  const viewer = openImageViewer({ src: '/user/images/solo.png', meta: '就这一张' }, environment);
  const body = byClass(viewer.root, 'stia-image-viewer__body');
  assert.equal(viewer.root.children[0].children[0].textContent, '查看原图');
  assert.equal(byClass(viewer.root, 'is-prev').hidden, true);
  assert.equal(byClass(viewer.root, 'is-next').hidden, true);
  swipe(body, [300, 400], [100, 400]);
  environment.window.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(viewer.image.src, '/user/images/solo.png');
  assert.equal(byClass(viewer.root, 'stia-image-viewer__hint').textContent, '点一下图片放大，长按图片保存');
  assert.equal(viewer.image.classList.contains('is-loading'), false, '刚打开时不淡');
  viewer.destroy();
});

test('2.7.0 翻着看时删掉当前这张：接着看后面那张，没有后面的就看前面那张，一张不剩才关；关掉时告诉来的地方最后看的是哪张', async () => {
  const environment = fakeEnvironment();
  const list = ['a', 'b', 'c'];
  const log = [];
  const viewer = openImageViewer(sequenceOf(list, log)('b'), environment);
  const title = () => viewer.root.children[0].children[0].textContent;
  const remove = () => everything(viewer.root).find(element => element.textContent === '删除');
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const open = () => environment.document.body.children.includes(viewer.root);

  remove().dispatch('click');
  await settle();
  assert.deepEqual(log, ['delete b']);
  assert.equal(open(), true, '不关');
  assert.equal(viewer.image.src, '/user/images/c.png', '接着看后面那张');
  assert.equal(title(), '2 / 2');

  remove().dispatch('click');
  await settle();
  assert.equal(viewer.image.src, '/user/images/a.png', '后面没有了：看前面那张');
  assert.equal(title(), '查看原图', '只剩一张');
  assert.equal(byClass(viewer.root, 'is-prev').hidden, true);
  assert.equal(byClass(viewer.root, 'is-next').hidden, true);

  remove().dispatch('click');
  await settle();
  assert.equal(open(), false, '一张不剩：关掉');
  assert.deepEqual(log, ['delete b', 'delete c', 'delete a', 'close a']);
});

test('2.7.0 翻到别的图再关：onClose 是最后看的那张的', () => {
  const environment = fakeEnvironment();
  const log = [];
  const viewer = openImageViewer(sequenceOf(['a', 'b', 'c'], log)('a'), environment);
  byClass(viewer.root, 'is-next').dispatch('click');
  byClass(viewer.root, 'is-next').dispatch('click');
  viewer.close();
  assert.deepEqual(log, ['close c']);
});
