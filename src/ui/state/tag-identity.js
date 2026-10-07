import { canonicalTag } from './tag-storage.js';

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function reconcileTagMetadata(message, parsedTags, uuid = createUuid) {
  message.extra ??= {};
  const previous = message.extra.stImageAtelier ?? {};
  const previousTags = Array.isArray(previous.tags) ? previous.tags : [];
  const unused = new Set(previousTags.map((_, index) => index));

  const tags = parsedTags.map((tag, ordinal) => {
    let matchedIndex = previousTags.findIndex((saved, index) =>
      unused.has(index) && saved.prompt === tag.prompt,
    );
    if (matchedIndex < 0 && previousTags[ordinal]?.prompt === tag.prompt) {
      matchedIndex = ordinal;
    }
    const saved = matchedIndex >= 0 ? previousTags[matchedIndex] : null;
    if (matchedIndex >= 0) unused.delete(matchedIndex);
    /* 聊天里只留轻量引用（见 tag-storage.js）。旧版的 resultIds / attempts / results 只在旧数据里
       还有时原样带上，读状态或瘦身时搬走；每次都补一个空的就会每次识别都算改动、整份聊天保存两遍。
       新标签直接用精简形。 */
    return canonicalTag({
      tagId: saved?.tagId || uuid(),
      prompt: tag.prompt,
      ordinal,
      ratio: tag.ratio,
      quality: tag.quality,
      count: tag.count,
      latestResultId: saved?.latestResultId || null,
      ...(Array.isArray(saved?.resultIds) ? { resultIds: saved.resultIds } : {}),
      ...(Array.isArray(saved?.attempts) ? { attempts: saved.attempts } : {}),
      ...(Array.isArray(saved?.results) ? { results: saved.results } : {}),
      ...(Array.isArray(saved?.resultRefs) ? { resultRefs: saved.resultRefs } : (saved ? {} : { resultRefs: [] })),
      autoAttempted: Boolean(saved?.autoAttempted),
      autoSuppressed: Boolean(saved?.autoSuppressed),
    });
  });

  const metadata = {
    messageUuid: previous.messageUuid || uuid(),
    tags,
    schemaVersion: 2,
  };
  message.extra.stImageAtelier = metadata;
  return {
    metadata,
    changed: JSON.stringify(previous) !== JSON.stringify(metadata),
  };
}

function tagIn(metadata, tagId) {
  return Array.isArray(metadata?.tags)
    ? metadata.tags.find(item => item?.tagId === tagId) || null
    : null;
}

/* 这一层正在生成新的滑动版本：extra 还是上一版留下的。不开流式时新版本的位置还空着，
   开流式时要看流式处理器。 */
function showsPreviousSwipe(message, messageId, isStreaming) {
  const pendingSwipe = Array.isArray(message?.swipes)
    && Number.isInteger(message.swipe_id)
    && typeof message.swipes[message.swipe_id] !== 'string';
  return pendingSwipe || Boolean(isStreaming(messageId));
}

/* 在聊天里找标签，并说明它现在在哪：
   - active：某一层当前显示的那一版；
   - swipe：同一层另一个滑动版本的存档。酒馆滑走时把整份 extra 深拷贝进
     swipe_info[旧版].extra 再换上另一版，画到一半被滑走的图要写回这份存档，滑回去才看得到。
   当前显示那一版自己的存档是过期拷贝，不算；正在生成新滑动版本时，这一层的 extra 还是
   上一版留下的，以上一版的存档为准。都找不到返回 null：消息被重新生成、删除、改动过，
   或者已经切到了别的聊天。 */
export function locateTag(chat, tagId, { isStreaming = () => false } = {}) {
  const messages = Array.isArray(chat) ? chat : [];
  let active = null;
  for (const [messageId, message] of messages.entries()) {
    const metadata = message?.extra?.stImageAtelier;
    const tag = tagIn(metadata, tagId);
    if (!tag) continue;
    active = { message, metadata, tag, placement: 'active' };
    if (!showsPreviousSwipe(message, messageId, isStreaming)) return active;
    break;
  }
  for (const message of messages) {
    if (!Array.isArray(message?.swipe_info)) continue;
    for (const [swipeId, swipe] of message.swipe_info.entries()) {
      if (swipeId === message.swipe_id) continue;
      const metadata = swipe?.extra?.stImageAtelier;
      const tag = tagIn(metadata, tagId);
      if (tag) return { message, metadata, tag, placement: 'swipe' };
    }
  }
  return active;
}
