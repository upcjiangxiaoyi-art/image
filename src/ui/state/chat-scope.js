/* 画廊的「只看这个聊天」和「跳到所在楼层」：一张图属不属于当前聊天、在第几楼。
   光看画廊记录上的 chatId 不够——聊天改过名、分支出来的聊天，记录上还是旧名字。所以以聊天里的引用为准：
   每一楼（当前版本和各个滑动版本的存档）用到的 messageUuid 和 tagId。 */
import { metadataTagIds } from './tag-identity.js';

function containersOf(message) {
  const list = [];
  if (message?.extra?.stImageAtelier) list.push({ metadata: message.extra.stImageAtelier, placement: 'active', swipeId: null });
  const swipes = Array.isArray(message?.swipe_info) ? message.swipe_info : [];
  for (const [swipeId, swipe] of swipes.entries()) {
    if (swipe?.extra?.stImageAtelier) list.push({ metadata: swipe.extra.stImageAtelier, placement: 'swipe', swipeId });
  }
  return list;
}

/* 当前聊天用到的 messageUuid、tagId，加上聊天名。 */
export function chatScope(chat, chatId = '') {
  const messageUuids = new Set();
  const tagIds = new Set();
  for (const message of Array.isArray(chat) ? chat : []) {
    for (const { metadata } of containersOf(message)) {
      if (metadata.messageUuid) messageUuids.add(metadata.messageUuid);
      for (const tagId of metadataTagIds(metadata)) tagIds.add(tagId);
    }
  }
  return { chatId: String(chatId || ''), messageUuids, tagIds };
}

export function belongsToChat(scope, record) {
  if (!scope || !record) return false;
  if (record.tagId && scope.tagIds.has(record.tagId)) return true;
  if (record.messageUuid && scope.messageUuids.has(record.messageUuid)) return true;
  return Boolean(scope.chatId) && record.chatId === scope.chatId;
}

/* 当前有没有打开一个聊天（没打开时「只看这个聊天」没意义）。 */
export function hasChat(scope) {
  return Boolean(scope && (scope.chatId || scope.tagIds.size || scope.messageUuids.size));
}

/* 这张图在当前聊天的哪一楼：先找当前显示的版本，再找滑动版本的存档；先按 tagId，再按 messageUuid。
   找不到返回 null（那一楼删了、重新生成过，或者图是别的聊天的）。 */
export function findMessageForRecord(chat, record) {
  if (!record) return null;
  const messages = Array.isArray(chat) ? chat : [];
  const byTag = metadata => Boolean(record.tagId) && metadataTagIds(metadata).includes(record.tagId);
  const byMessage = metadata => Boolean(record.messageUuid) && metadata.messageUuid === record.messageUuid;
  for (const match of [byTag, byMessage]) {
    for (const placement of ['active', 'swipe']) {
      for (const [messageId, message] of messages.entries()) {
        const found = containersOf(message).find(item => item.placement === placement && match(item.metadata));
        if (found) return { messageId, placement, swipeId: found.swipeId };
      }
    }
  }
  return null;
}
