import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createMessageRenderer } from '../../src/ui/renderer/message-renderer.js';
import { createMessageEvents } from '../../src/ui/events/message-events.js';
import { createStore } from '../../src/ui/state/store.js';

function setup() {
  const dom = new JSDOM('<div id="chat"><div class="mes" mesid="0"><div class="mes_text">正文，提示词暂时被其他渲染隐藏。</div></div></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'HTMLElement', 'Element', 'Range', 'MutationObserver']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  globalThis.CSS = { escape: String };
  const message = { is_user: false, mes: '正文 <draw>海边场景</draw><draw>星空场景</draw>' };
  const tags = [
    { tagId: 'tag-sea', prompt: '海边场景', ordinal: 0, count: 1 },
    { tagId: 'tag-sky', prompt: '星空场景', ordinal: 1, count: 1 },
  ];
  const store = createStore();
  store.set({ settings: { enabled: true, autoGenerate: false } });
  const counters = { resolve: 0, generation: 0 };
  const api = { async resolveTags(ids) { counters.resolve++; return ids.map(tagId => ({ tagId, attempts: [], results: [] })); } };
  const compat = {
    chat: () => [message], currentChatId: () => 'test-chat',
    messageElement: () => dom.window.document.querySelector('.mes'),
    save: async () => {}, on() {},
  };
  const renderer = createMessageRenderer({ compat, api, store, actions: {} });
  const events = createMessageEvents({ compat, api, store, renderer, autoQueue: { enqueue() { counters.generation++; } } });
  return { dom, container: document.querySelector('.mes_text'), renderer, events, tags, counters };
}

test('楼底备用卡片重复挂载零 DOM 变动，保留展开状态', () => {
  const { dom, container, renderer, tags } = setup();
  try {
    renderer.mount('0', tags);
    const list = container.querySelector('.stia-card-list');
    const card = list.firstChild;
    const details = card.querySelector('details'); details.open = true;
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    for (let i = 0; i < 10; i++) renderer.mount('0', tags);
    assert.equal(observer.takeRecords().length, 0);
    assert.equal(container.querySelector('.stia-card-list'), list);
    assert.equal(list.firstChild, card);
    assert.equal(details.open, true);
    observer.disconnect();
  } finally { dom.window.close(); }
});

test('原位置恢复后只迁移对应卡片，其余备用卡片稳定保留', () => {
  const { dom, container, renderer, tags } = setup();
  try {
    renderer.mount('0', tags);
    const list = container.querySelector('.stia-card-list');
    const sea = list.firstChild, sky = list.lastChild;
    list.insertAdjacentHTML('beforebegin', '<p><draw>海边场景</draw></p>');
    renderer.mount('0', tags);
    assert.equal(sea.closest('.stia-card-list'), null);
    assert.equal(sky.parentElement, list);
    assert.equal(container.querySelectorAll('.stia-card').length, 2);
    list.insertAdjacentHTML('beforebegin', '<p><draw>星空场景</draw></p>');
    renderer.mount('0', tags);
    assert.equal(container.querySelector('.stia-card-list'), null);
    assert.equal(container.querySelectorAll('.stia-card').length, 2);
    assert.ok(container.textContent.includes('正文，提示词暂时被其他渲染隐藏。'));
  } finally { dom.window.close(); }
});

test('真实观察器下，楼底卡片和账本追加不会形成持续查询循环', async () => {
  const { dom, container, events, counters } = setup();
  const timeouts = new Set(), intervals = new Set();
  const originalTimeout = globalThis.setTimeout, originalInterval = globalThis.setInterval;
  globalThis.setTimeout = (...args) => { const id = originalTimeout(...args); timeouts.add(id); return id; };
  globalThis.setInterval = (...args) => { const id = originalInterval(...args); intervals.add(id); return id; };
  try {
    events.bind(); await events.hydrate();
    await delay(450);
    const settled = counters.resolve;
    await delay(450);
    assert.equal(counters.resolve, settled, '卡片已放好后必须停止重复查询');
    // 模拟 IPE 正文结束时追加楼内账本，仍不应启动自循环。
    container.insertAdjacentHTML('beforeend', '<details class="ipe-ledger-inline"><summary>潮汐回响</summary><div>新账本</div></details>');
    await delay(450);
    const afterLedger = counters.resolve;
    assert.ok(afterLedger > settled, '确实经过了一次跨插件 DOM 通知');
    await delay(450);
    assert.equal(counters.resolve, afterLedger, '账本通知处理完后必须再次停稳');
    assert.equal(counters.generation, 0, '关闭自动生图没有额外生图请求');
    assert.equal(container.querySelectorAll('.stia-card').length, 2);
  } finally {
    for (const id of timeouts) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
    globalThis.setTimeout = originalTimeout; globalThis.setInterval = originalInterval;
    dom.window.close();
  }
});
