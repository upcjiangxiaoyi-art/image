/* 2.2.0 画廊「只看这个聊天」「跳到所在楼层」：一张图属不属于当前聊天、在第几楼。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { belongsToChat, chatScope, findMessageForRecord, hasChat } from '../../src/ui/state/chat-scope.js';

const ref = (messageUuid, ...tagIds) => ({ stImageAtelier: { messageUuid, tagIds } });

const chat = [
  { is_user: true, mes: '你好' },
  { is_user: false, mes: '<draw>a</draw>', extra: ref('m1', 't1') },
  {
    is_user: false,
    mes: '<draw>c</draw>',
    swipe_id: 1,
    swipes: ['<draw>b</draw>', '<draw>c</draw>'],
    swipe_info: [{ extra: ref('m2', 't2-old') }, { extra: ref('m2', 't2') }],
    extra: ref('m2', 't2'),
  },
  /* 旧格式的楼。 */
  { is_user: false, mes: '<draw>d</draw>', extra: { stImageAtelier: { messageUuid: 'm3', tags: [{ tagId: 't3', prompt: 'd' }] } } },
];

test('聊天范围：当前版本和滑动存档里的 messageUuid、tagId 都算，旧格式的楼也算', () => {
  const scope = chatScope(chat, '钟由时 - 聊天');
  assert.equal(scope.chatId, '钟由时 - 聊天');
  assert.deepEqual([...scope.tagIds].sort(), ['t1', 't2', 't2-old', 't3']);
  assert.deepEqual([...scope.messageUuids].sort(), ['m1', 'm2', 'm3']);
  assert.equal(hasChat(scope), true);
  assert.equal(hasChat(chatScope([], '')), false, '没打开聊天');
  assert.equal(hasChat(chatScope([], '空聊天')), true);
  assert.equal(hasChat(null), false);
});

test('一张图属不属于这个聊天：按 tagId、messageUuid 认，聊天改过名也认得；都对不上才看聊天名', () => {
  const scope = chatScope(chat, '改名之后的聊天');
  assert.equal(belongsToChat(scope, { tagId: 't1', chatId: '改名之前的聊天' }), true, '改过名，按标签认');
  assert.equal(belongsToChat(scope, { tagId: 'gone', messageUuid: 'm2', chatId: '改名之前的聊天' }), true, '标签换过，按楼认');
  assert.equal(belongsToChat(scope, { tagId: 't2-old', chatId: 'x' }), true, '另一个滑动版本的图也是这个聊天的');
  assert.equal(belongsToChat(scope, { tagId: 'other', messageUuid: 'mx', chatId: '改名之后的聊天' }), true, '楼删了，按聊天名认');
  assert.equal(belongsToChat(scope, { tagId: 'other', messageUuid: 'mx', chatId: '别的聊天' }), false);
  assert.equal(belongsToChat(scope, { tagId: 'other' }), false);
  assert.equal(belongsToChat(null, { tagId: 't1' }), false);
  assert.equal(belongsToChat(chatScope([], ''), { chatId: '' }), false, '没有聊天名时不按空名字认');
});

test('这张图在第几楼：先找当前显示的版本，再找滑动存档；先按标签，再按楼；找不到返回 null', () => {
  assert.deepEqual(findMessageForRecord(chat, { tagId: 't1' }), { messageId: 1, placement: 'active', swipeId: null });
  assert.deepEqual(findMessageForRecord(chat, { tagId: 't2' }), { messageId: 2, placement: 'active', swipeId: null });
  assert.deepEqual(findMessageForRecord(chat, { tagId: 't2-old' }), { messageId: 2, placement: 'swipe', swipeId: 0 }, '在另一个滑动版本里');
  assert.deepEqual(findMessageForRecord(chat, { tagId: 't3' }), { messageId: 3, placement: 'active', swipeId: null }, '旧格式的楼');
  assert.deepEqual(findMessageForRecord(chat, { tagId: 'reminted', messageUuid: 'm1' }), { messageId: 1, placement: 'active', swipeId: null }, '标签换过，按楼找');
  assert.equal(findMessageForRecord(chat, { tagId: 'nope', messageUuid: 'nope' }), null);
  assert.equal(findMessageForRecord(chat, null), null);
  assert.equal(findMessageForRecord(undefined, { tagId: 't1' }), null);
});
