import test from 'node:test';
import assert from 'node:assert/strict';
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
