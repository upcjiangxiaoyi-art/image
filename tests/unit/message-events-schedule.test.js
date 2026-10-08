import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageEvents } from '../../src/ui/events/message-events.js';
import { createStore } from '../../src/ui/state/store.js';

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
