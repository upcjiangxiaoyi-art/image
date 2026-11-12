import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createStCompat } from '../../src/ui/compat/st-api.js';

test('同时订阅所有存在的消息更新事件', () => {
  const registered = [];
  const handler = () => {};
  const compat = createStCompat({
    getContext: () => ({ chat: [] }),
    eventTypes: {
      MESSAGE_UPDATED: 'message-updated',
      MESSAGE_EDITED: 'message-edited',
    },
    eventSource: {
      on(eventName, callback) {
        registered.push([eventName, callback]);
      },
    },
  });

  const selected = compat.on(['MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MISSING_EVENT'], handler);
  assert.deepEqual(selected, ['message-updated', 'message-edited']);
  assert.deepEqual(registered, [
    ['message-updated', handler],
    ['message-edited', handler],
  ]);
});

test('isStreaming 只认酒馆正在流式输出的那一层，写完、被停或别的层都不算', () => {
  let processor = null;
  const chat = [{}, {}, {}];
  const compat = createStCompat({ getContext: () => ({ chat, streamingProcessor: processor }) });
  assert.equal(compat.isStreaming(2), false, '没有在生成');
  processor = { messageId: 2, isFinished: false, isStopped: false };
  assert.equal(compat.isStreaming(2), true);
  assert.equal(compat.isStreaming('2'), true, 'mesid 字符串也认');
  assert.equal(compat.isStreaming(1), false, '别的层不受影响');
  processor = { messageId: -1, isFinished: false, isStopped: false };
  assert.equal(compat.isStreaming(2), true, '新内容还没开始写时，正在准备的是最后一层（重 roll 时的滑动）');
  assert.equal(compat.isStreaming(1), false);
  processor = { messageId: 2, isFinished: true, isStopped: false };
  assert.equal(compat.isStreaming(2), false, '写完后 MESSAGE_RECEIVED 触发时 isFinished 已经是 true');
  processor = { messageId: 2, isFinished: false, isStopped: true };
  assert.equal(compat.isStreaming(2), false, '被停止或出错');
});

test('saveSoon：有酒馆的 saveChatDebounced 就并进它；没有就自己拖一拍再 save，期间再叫也只存一次', async () => {
  let debounced = 0;
  const withTavern = createStCompat({
    getContext: () => ({ chat: [] }),
    saveChatConditional: async () => { throw new Error('不该当场存'); },
    saveChatDebounced: () => { debounced += 1; },
  });
  await withTavern.saveSoon();
  await withTavern.saveSoon();
  assert.equal(debounced, 2, '每次都交给酒馆的防抖，由它合并');

  let saves = 0;
  const timers = [];
  const fallback = createStCompat({
    getContext: () => ({ chat: [] }),
    saveChatConditional: async () => { saves += 1; },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
  });
  await fallback.saveSoon();
  await fallback.saveSoon();
  assert.equal(saves, 0, '还没到点');
  assert.equal(timers.length, 1, '一拍里叫两次只排一个定时器');
  assert.equal(timers[0].delay, 1000);
  timers[0].callback();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saves, 1, '到点存一次');
  await fallback.saveSoon();
  assert.equal(timers.length, 2, '存完再叫才排下一个');

  let viaContext = 0;
  const fromContext = createStCompat({ getContext: () => ({ chat: [], saveChatDebounced: () => { viaContext += 1; } }) });
  await fromContext.saveSoon();
  assert.equal(viaContext, 1, '没从 script.js 拿到时，getContext() 里的也认');
  await assert.doesNotReject(fallback.save, '当场保存照旧可用');
});

test('currentCharacterKey / currentCharacterName：单人按头像文件名，群聊按群 id，没开聊天为空', () => {
  let ctx = { characterId: 1, characters: [{ name: 'A', avatar: 'a.png' }, { name: 'B', avatar: 'b.png' }], groups: [] };
  const compat = createStCompat({ getContext: () => ctx });
  assert.equal(compat.currentCharacterKey(), 'char:b.png');
  assert.equal(compat.currentCharacterName(), 'B');
  ctx = { characterId: undefined, groupId: 'g1', characters: [], groups: [{ id: 'g1', name: '群' }] };
  assert.equal(compat.currentCharacterKey(), 'group:g1');
  assert.equal(compat.currentCharacterName(), '群');
  ctx = { characterId: 3, characters: [] };
  assert.equal(compat.currentCharacterKey(), 'char-index:3', '没有头像名就退回下标');
  ctx = { characters: [] };
  assert.equal(compat.currentCharacterKey(), '');
  assert.equal(compat.currentCharacterName(), '');
});

/* 2.2.0 画廊「跳到所在楼层」。酒馆只把最近的一部分楼层画在页面上。 */
function chatDom(t, rendered) {
  const dom = new JSDOM('<!DOCTYPE html><div id="chat"></div><div id="show_more_messages"></div>', { url: 'http://localhost' });
  const previous = { document: globalThis.document, CSS: globalThis.CSS };
  globalThis.document = dom.window.document;
  if (!globalThis.CSS?.escape) globalThis.CSS = { escape: value => String(value) };
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.CSS = previous.CSS;
    dom.window.close();
  });
  const chat = dom.window.document.querySelector('#chat');
  const scrolled = [];
  const addRow = (id, { prepend = false } = {}) => {
    const row = dom.window.document.createElement('div');
    row.className = 'mes';
    row.setAttribute('mesid', String(id));
    row.scrollIntoView = options => scrolled.push([id, options]);
    if (prepend) chat.prepend(row);
    else chat.append(row);
    return row;
  };
  for (const id of rendered) addRow(id);
  return { dom, chat, addRow, scrolled };
}

test('jumpToMessage：这一楼已经画在页面上，直接滚过去并闪一下，过一会儿收掉', async t => {
  const { chat, scrolled } = chatDom(t, [7, 8, 9]);
  const timers = [];
  const compat = createStCompat({ getContext: () => ({ chat: [] }), setTimer: (callback, delay) => timers.push([callback, delay]) });
  assert.equal(await compat.jumpToMessage(8), true);
  assert.deepEqual(scrolled, [[8, { block: 'center', behavior: 'auto' }]]);
  const row = chat.querySelector('.mes[mesid="8"]');
  assert.equal(row.classList.contains('stia-jump-highlight'), true);
  timers.at(-1)[0]();
  assert.equal(row.classList.contains('stia-jump-highlight'), false);
  assert.equal(await compat.jumpToMessage(-1), false);
  assert.equal(await compat.jumpToMessage('abc'), false);
});

test('jumpToMessage：这一楼还没画出来，就让酒馆一批批加载更早的，直到它出现', async t => {
  const { addRow, scrolled } = chatDom(t, [40, 41]);
  let batches = 0;
  const compat = createStCompat({
    getContext: () => ({ chat: [] }),
    setTimer: () => {},
    showMoreMessages: async () => {
      batches += 1;
      const first = batches === 1 ? 20 : 0;
      for (let id = first + 19; id >= first; id -= 1) addRow(id, { prepend: true });
    },
  });
  assert.equal(await compat.jumpToMessage(5), true);
  assert.equal(batches, 2, '加载了两批才看到第 5 楼');
  assert.equal(scrolled.at(-1)[0], 5);
});

test('jumpToMessage：没有 showMoreMessages 的老酒馆去点「加载更多」；到头了还没有就试 /chat-jump，再不行返回 false', async t => {
  const { dom, addRow, scrolled } = chatDom(t, [10, 11]);
  let clicks = 0;
  dom.window.document.querySelector('#show_more_messages').addEventListener('click', () => {
    clicks += 1;
    if (clicks === 1) for (let id = 9; id >= 0; id -= 1) addRow(id, { prepend: true });
  });
  const commands = [];
  const compat = createStCompat({
    getContext: () => ({ chat: [], executeSlashCommandsWithOptions: async command => { commands.push(command); } }),
    setTimer: callback => { callback(); },
  });
  assert.equal(await compat.jumpToMessage(3), true, '点一次「加载更多」就出来了');
  assert.equal(clicks, 1);
  assert.equal(scrolled.at(-1)[0], 3);

  /* 第 30 楼比页面上最晚的还晚、又没画出来（酒馆状态不一致）：不乱加载，试一次 /chat-jump，还没有就算了。 */
  assert.equal(await compat.jumpToMessage(30), false);
  assert.deepEqual(commands, ['/chat-jump 30']);
  assert.equal(clicks, 1, '不会白点「加载更多」');
});
