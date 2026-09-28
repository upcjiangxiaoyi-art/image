import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoQueue } from '../../src/ui/state/auto-queue.js';

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('同一标签在排队或生成期间只会进入自动队列一次', async () => {
  const releases = [];
  let calls = 0;
  const queue = createAutoQueue(async () => {
    calls += 1;
    await new Promise(resolve => releases.push(resolve));
  });
  const tag = { tagId: 'tag-a' };

  assert.equal(queue.enqueue(tag), true);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(queue.enqueue(tag), false);

  releases.shift()();
  await nextTurn();
  assert.equal(queue.enqueue(tag), true);
  await Promise.resolve();
  assert.equal(calls, 2);
  releases.shift()();
  await nextTurn();
});

test('流式输出期间不排自动生图，写完后只排定稿里的那个标签（正则改写、去行尾空格都不会留下失效标签）', async t => {
  const { JSDOM } = await import('jsdom');
  const { createMessageEvents } = await import('../../src/ui/events/message-events.js');
  const { createStore } = await import('../../src/ui/state/store.js');
  const dom = new JSDOM('<div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div></div></div>');
  const previous = {};
  for (const key of ['window', 'document', 'Node', 'MutationObserver']) {
    previous[key] = globalThis[key];
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) globalThis[key] = value;
    dom.window.close();
  });

  const message = { is_user: false, mes: '正文 <draw ratio="portrait">海边   \n夕阳   </draw> 还在写' };
  let streaming = true;
  const enqueued = [];
  const store = createStore();
  store.set({ settings: { enabled: true, autoGenerate: true } });
  const events = createMessageEvents({
    compat: {
      chat: () => [message],
      currentChatId: () => 'chat',
      save: async () => {},
      on() {},
      isStreaming: () => streaming,
    },
    api: { resolveTags: async ids => ids.map(tagId => ({ tagId, tag: { autoAttempted: false }, attempts: [], results: [] })) },
    store,
    renderer: { mount() {} },
    autoQueue: { enqueue: tag => { enqueued.push(tag); return true; } },
  });

  await events.processMessage(0, { live: true });
  assert.equal(enqueued.length, 0, '还在写的时候不排队');
  const streamedTagId = message.extra.stImageAtelier.tags[0].tagId;

  streaming = false;
  message.mes = '正文 <draw ratio="portrait">海边\n夕阳，写完后被正则补了一句</draw> 写完了';
  await events.processMessage(0, { live: true, generationType: 'normal' });
  assert.equal(enqueued.length, 1, '写完后排一次');
  const finalTag = message.extra.stImageAtelier.tags[0];
  assert.notEqual(finalTag.tagId, streamedTagId, '定稿的提示词变了，标签随之更新');
  assert.equal(enqueued[0].tagId, finalTag.tagId, '排进队的是定稿里的标签，不会轮到一个已经不存在的标签');
});
