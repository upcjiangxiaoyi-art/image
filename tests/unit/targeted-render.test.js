import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createStore } from '../../src/ui/state/store.js';
import { createMessageRenderer } from '../../src/ui/renderer/message-renderer.js';

test('状态通知带上变了什么：单张卡的改动只报 tagId，全局改动报 all', () => {
  const store = createStore();
  const seen = [];
  store.subscribe((_state, change) => seen.push(change));
  store.setTag('a', { tagId: 'a', attempts: [], results: [] });
  store.applyResolvedTag('b', { tagId: 'b', attempts: [], results: [] });
  store.set({ settings: { ...store.state.settings, themeMode: 'dark' } });
  store.removeTag('a');
  store.removeTag('missing');
  assert.deepEqual(seen, [{ tagId: 'a' }, { tagId: 'b' }, { all: true }, { tagId: 'a' }]);
});

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><div id="chat"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'CSS', 'HTMLElement', 'Element', 'Range']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  if (!globalThis.CSS?.escape) {
    globalThis.CSS = { escape: value => String(value).replace(/[^\w-]/g, ch => `\\${ch}`) };
  }
  const chat = [];
  const elements = [];
  for (const [index, prompt] of ['first prompt', 'second prompt'].entries()) {
    const message = dom.window.document.createElement('div');
    message.className = 'mes';
    message.setAttribute('mesid', String(index));
    message.innerHTML = `<div class="mes_text"><p>&lt;draw&gt;${prompt}&lt;/draw&gt;</p></div>`;
    dom.window.document.querySelector('#chat').appendChild(message);
    elements.push(message);
    chat.push({ mes: `<draw>${prompt}</draw>` });
  }
  const store = createStore();
  /* 卡片每重画一次都要读一次自己的状态：数读了几次就知道重画了几次。 */
  const reads = new Map();
  const tagStates = store.state.tagStates;
  store.state.tagStates = new Proxy(tagStates, {
    get(target, property) {
      if (property === 'get') {
        return tagId => {
          reads.set(tagId, (reads.get(tagId) || 0) + 1);
          return target.get(tagId);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const renderer = createMessageRenderer({
    compat: { messageElement: messageId => elements[Number(messageId)], chat: () => chat },
    api: { fileUrl: () => '' },
    store,
    actions: {},
  });
  renderer.mount('0', [{ tagId: 'tag-1', prompt: 'first prompt', ordinal: 0, count: 1 }]);
  renderer.mount('1', [{ tagId: 'tag-2', prompt: 'second prompt', ordinal: 0, count: 1 }]);
  return { store, renderer, reads, dom };
}

test('一张卡的状态变了只重画那一张；设置变了才全部重画', () => {
  const { store, reads, dom } = setup();
  assert.equal(dom.window.document.querySelectorAll('.stia-card').length, 2);
  const before = new Map(reads);
  store.setTag('tag-1', { tagId: 'tag-1', attempts: [{ attemptId: 'a', status: 'generating' }], results: [] });
  assert.equal(reads.get('tag-1'), (before.get('tag-1') || 0) + 1, '变了的那张重画一次');
  assert.equal(reads.get('tag-2'), before.get('tag-2'), '另一张不动');
  const afterTag = new Map(reads);
  store.set({ settings: { ...store.state.settings, themeMode: 'dark' } });
  assert.equal(reads.get('tag-1'), afterTag.get('tag-1') + 1, '设置变了两张都重画');
  assert.equal(reads.get('tag-2'), afterTag.get('tag-2') + 1);
  const afterAll = new Map(reads);
  store.setTag('missing', { tagId: 'missing', attempts: [], results: [] });
  assert.deepEqual([...reads], [...afterAll], '不在页面上的标签变了，谁都不重画');
});
