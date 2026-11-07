import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageEvents } from '../../src/ui/events/message-events.js';
import { createStore } from '../../src/ui/state/store.js';
import { JSDOM } from 'jsdom';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup() {
  const handlers = new Map();
  let chatReads = 0;
  let immediate = 0;
  let soon = 0;
  const message = { is_user: false, mes: '<draw>sunset</draw>', extra: {} };
  const compat = {
    chat: () => { chatReads += 1; return [message]; },
    currentChatId: () => 'chat-1',
    save: async () => { immediate += 1; },
    saveSoon: async () => { soon += 1; },
    isStreaming: () => false,
    on: (names, handler) => { for (const name of names) handlers.set(name, handler); return names; },
  };
  const api = { resolveTags: async ids => ids.map(tagId => ({ tagId, tag: null, attempts: [], results: [] })) };
  const renderer = { mount: () => ({ mounted: 0, fallback: 0 }) };
  const store = createStore();
  const events = createMessageEvents({ compat, api, store, renderer, autoQueue: { enqueue() {} } });
  globalThis.document = { querySelector: () => null, addEventListener() {} };
  events.bind();
  return { handlers, message, counts: () => ({ chatReads, immediate, soon }) };
}

test('新标签的保存走延后合并，不当场整份存聊天', async () => {
  const { handlers, message, counts } = setup();
  await handlers.get('MESSAGE_RECEIVED')(0, 'normal');
  assert.equal(message.extra.stImageAtelier.tags.length, 1, '标签 ID 已经写进内存里的 extra，酒馆紧跟着的保存会带上');
  assert.equal(counts().soon, 1);
  assert.equal(counts().immediate, 0);
});

test('画完一楼的事件走防抖，和 DOM 监听合成一次，不在流式结束那一瞬间再做一遍', async () => {
  const { handlers, counts } = setup();
  const before = counts().chatReads;
  handlers.get('CHARACTER_MESSAGE_RENDERED')(0);
  handlers.get('MESSAGE_RENDERED')(0);
  assert.equal(counts().chatReads, before, '事件到的那一刻不处理');
  await delay(220);
  assert.equal(counts().chatReads, before + 1, '落定后只处理一次');
});

/* 1.8.3 生成期间撤哨：真 DOM、真 MutationObserver（jsdom）。 */
function domSetup({ observerPauseMaxMs } = {}) {
  const dom = new JSDOM(
    '<!DOCTYPE html><div id="chat"><div class="mes" mesid="0"><div class="mes_text">正文</div></div></div>',
    { url: 'http://localhost' },
  );
  for (const key of ['window', 'document', 'Node', 'MutationObserver', 'HTMLElement', 'Element']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  const handlers = new Map();
  let resolves = 0;
  /* 聊天里有三楼，DOM 一开始只渲染了第 0 楼（酒馆按需渲染）。 */
  const messages = Array.from({ length: 3 }, () => ({ is_user: false, mes: '<draw>sunset</draw>', extra: {} }));
  const compat = {
    chat: () => messages,
    currentChatId: () => 'chat-1',
    save: async () => {},
    saveSoon: async () => {},
    isStreaming: () => false,
    on: (names, handler) => { for (const name of names) handlers.set(name, handler); return names; },
  };
  const api = {
    resolveTags: async ids => { resolves += 1; return ids.map(tagId => ({ tagId, tag: null, attempts: [], results: [] })); },
  };
  const renderer = { mount: () => ({ mounted: 0, fallback: 0 }) };
  const events = createMessageEvents({
    compat, api, store: createStore(), renderer, autoQueue: { enqueue() {} }, observerPauseMaxMs,
  });
  events.bind();
  const text = dom.window.document.querySelector('.mes_text');
  const renderRow = (mesid, html) => {
    const row = dom.window.document.createElement('div');
    row.className = 'mes';
    row.setAttribute('mesid', String(mesid));
    row.innerHTML = `<div class="mes_text">${html}</div>`;
    dom.window.document.querySelector('#chat').append(row);
  };
  return { handlers, text, renderRow, resolves: () => resolves };
}

test('生成期间撤掉 DOM 监听：吐字时 DOM 怎么变都不处理；结束后接回，补查最后一楼和撤哨期间露着 <draw> 的楼', async () => {
  const { handlers, text, renderRow, resolves } = domSetup();
  text.textContent = '改一下';
  await delay(220);
  assert.equal(resolves(), 1, '平时 DOM 一变就处理');

  handlers.get('GENERATION_STARTED')('normal', {}, false);
  text.textContent = '流式第一帧';
  await delay(0);
  text.textContent = '流式第二帧';
  /* 撤哨期间往上翻，酒馆把第 1 楼渲染出来了，<draw> 还露着；第 2 楼是正在生成的最后一楼。 */
  renderRow(1, '<p>旧楼</p><draw>sunset</draw>');
  renderRow(2, '<p>生成中</p>');
  await delay(220);
  assert.equal(resolves(), 1, '生成期间不处理');

  handlers.get('GENERATION_ENDED')(3);
  await delay(220);
  assert.equal(resolves(), 3, '接回时补查最后一楼，也补渲染出来还露着 <draw> 的第 1 楼');

  text.textContent = '生成完再改';
  await delay(220);
  assert.equal(resolves(), 4, '接回后 DOM 监听照常');
});

test('收到新楼的事件自己处理那一楼，接回时不再补查一遍', async () => {
  const { handlers, resolves } = domSetup();
  handlers.get('GENERATION_STARTED')('normal', {}, false);
  await handlers.get('MESSAGE_RECEIVED')(0, 'normal');
  assert.equal(resolves(), 1);
  await delay(220);
  assert.equal(resolves(), 1, '没有多处理一次');
  handlers.get('GENERATION_ENDED')(1);
  await delay(220);
  assert.equal(resolves(), 1, '已经接回的，结束事件不再补');
});

test('dryRun 的生成开始不撤哨；酒馆没发结束事件时到点自动接回', async () => {
  const { handlers, text, resolves } = domSetup({ observerPauseMaxMs: 100 });
  handlers.get('GENERATION_STARTED')('normal', {}, true);
  text.textContent = '试跑期间';
  await delay(220);
  assert.equal(resolves(), 1, 'dryRun 不撤哨');

  handlers.get('GENERATION_STARTED')('normal', {}, false);
  text.textContent = '真生成';
  await delay(50);
  assert.equal(resolves(), 1, '撤哨中');
  await delay(320);
  assert.equal(resolves(), 2, '到点自动接回并补查');
});
