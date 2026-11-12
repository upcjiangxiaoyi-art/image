/* 楼层里只留引用：extra.stImageAtelier = { messageUuid, tagIds }。提示词在正文的 <draw> 里，
   标签的状态（当前显示哪张、图片引用、自动生图标记）在按聊天分的侧文件里按 tagId 记（chat-tag-store.js）。
   2.0.0 之前楼层里是 { messageUuid, tags: [{ tagId, prompt, …, resultRefs, … }] }，旧格式只读不改，
   由「整理旧数据」一次搬完。 */
import { parseDrawTags } from '../parser/draw-parser.js';
import { normalizeTagRecord, promptHash } from '../api/chat-tag-store.js';

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function isLegacyMetadata(metadata) {
  return Array.isArray(metadata?.tags);
}

/* 这份元数据（引用或旧格式）按顺序列出的 tagId。 */
export function metadataTagIds(metadata) {
  if (Array.isArray(metadata?.tagIds)) return metadata.tagIds.filter(id => typeof id === 'string' && id);
  if (Array.isArray(metadata?.tags)) return metadata.tags.map(tag => tag?.tagId).filter(id => typeof id === 'string' && id);
  return [];
}

export function legacyTagOf(metadata, tagId) {
  return Array.isArray(metadata?.tags) ? metadata.tags.find(tag => tag?.tagId === tagId) || null : null;
}

/* 旧格式标签 → 侧文件记录（不查画廊的基础版；要按画廊补路径用 direct-client 里的 leanTag）。 */
export function legacyTagRecord(tag) {
  return normalizeTagRecord({
    promptHash: promptHash(tag?.prompt),
    latestResultId: tag?.latestResultId,
    resultRefs: Array.isArray(tag?.resultRefs)
      ? tag.resultRefs
      : (Array.isArray(tag?.resultIds) ? tag.resultIds.map(resultId => ({ resultId })) : []),
    autoAttempted: tag?.autoAttempted,
    autoSuppressed: tag?.autoSuppressed,
  });
}

export function buildRef(messageUuid, tagIds) {
  return { messageUuid: String(messageUuid), tagIds: [...tagIds] };
}

export function sameRef(current, next) {
  if (!current || isLegacyMetadata(current)) return false;
  if (current.messageUuid !== next.messageUuid) return false;
  const ids = Array.isArray(current.tagIds) ? current.tagIds : null;
  if (!ids || ids.length !== next.tagIds.length) return false;
  if (ids.some((id, index) => id !== next.tagIds[index])) return false;
  return Object.keys(current).length === 2;
}

function promptAt(text, ordinal, fallback = '') {
  if (typeof text !== 'string' || !Number.isInteger(ordinal) || ordinal < 0) return fallback;
  return parseDrawTags(text, { warn: () => {} })[ordinal]?.prompt ?? fallback;
}

/* 认标签：正文里的每个 <draw> 对上楼里原来的哪个 tagId。
   提示词一样（指纹一样）就是同一个：改了提示词就是新标签（新 tagId）。records(tagId) 取侧文件里的记录；
   旧格式楼层没有记录时拿楼里那份自己的字段顶上。
   楼里有 ID、侧文件里却没有它的记录时（侧文件丢了、没写上、换过聊天名、分支出来的聊天），没有证据说明
   提示词变过，就按位置认回原来的 ID。绝不能因为侧文件不在就给整楼换新 ID：图是按 ID 挂的，一换卡片上就空了，
   还会被当成没画过的新标签（2.0.0～2.0.2 就是这么把图从卡片上弄掉的）。
   返回：
   - ref：这楼该有的引用 { messageUuid, tagIds }
   - refChanged：和楼里现在存的不一样（旧格式一律算不一样）
   - legacy：楼里现在是旧格式
   - identityChanged：tagId 的集合或顺序变了（旧格式楼层只有这时才升级成引用，否则不动聊天）
   - records：这些标签的记录（新的按默认值建；原来的保留）
   - tags：给卡片和生图用的合并视图
   - created：这一次才拿到新 ID 的标签（楼里原来没有它） */
export function reconcileMessage(message, parsedTags, { records = () => null, uuid = createUuid } = {}) {
  const previous = message?.extra?.stImageAtelier ?? {};
  const legacy = isLegacyMetadata(previous);
  const previousIds = metadataTagIds(previous);
  const candidates = previousIds.map(tagId => {
    const legacyTag = legacy ? legacyTagOf(previous, tagId) : null;
    const record = records(tagId) || (legacyTag ? legacyTagRecord(legacyTag) : null);
    return { tagId, record, hash: record?.promptHash || '' };
  });
  const unused = new Set(candidates.keys());
  const hashes = parsedTags.map(parsed => promptHash(parsed.prompt));
  const assigned = new Array(parsedTags.length).fill(null);
  /* 第一轮：提示词指纹一样的就是同一个。 */
  hashes.forEach((hash, ordinal) => {
    const index = candidates.findIndex((candidate, position) =>
      unused.has(position) && candidate.hash && candidate.hash === hash);
    if (index < 0) return;
    unused.delete(index);
    assigned[ordinal] = candidates[index];
  });
  /* 第二轮：剩下没对上的标签，按顺序认回那些「楼里有 ID、却没有记录」的。 */
  const unrecorded = [...unused].filter(position => !candidates[position].hash).sort((left, right) => left - right);
  assigned.forEach((value, ordinal) => {
    if (value || !unrecorded.length) return;
    const position = unrecorded.shift();
    unused.delete(position);
    assigned[ordinal] = candidates[position];
  });
  const nextRecords = {};
  const tags = parsedTags.map((parsed, ordinal) => {
    const hash = hashes[ordinal];
    const matched = assigned[ordinal];
    const tagId = matched?.tagId || uuid();
    const record = normalizeTagRecord({ ...(matched?.record || {}), promptHash: hash });
    nextRecords[tagId] = record;
    return {
      tagId,
      prompt: parsed.prompt,
      ordinal,
      ratio: parsed.ratio,
      quality: parsed.quality,
      count: parsed.count,
      latestResultId: record.latestResultId,
      resultRefs: record.resultRefs,
      autoAttempted: record.autoAttempted,
      autoSuppressed: record.autoSuppressed,
    };
  });
  const ref = buildRef(previous.messageUuid || uuid(), tags.map(tag => tag.tagId));
  return {
    ref,
    refChanged: !sameRef(previous, ref),
    legacy,
    identityChanged: previousIds.join('\n') !== ref.tagIds.join('\n'),
    records: nextRecords,
    tags,
    created: ref.tagIds.filter(tagId => !previousIds.includes(tagId)),
  };
}

/* 这一层正在生成新的滑动版本：extra 还是上一版留下的。不开流式时新版本的位置还空着，
   开流式时要看流式处理器。 */
function showsPreviousSwipe(message, messageId, isStreaming) {
  const pendingSwipe = Array.isArray(message?.swipes)
    && Number.isInteger(message.swipe_id)
    && typeof message.swipes[message.swipe_id] !== 'string';
  return pendingSwipe || Boolean(isStreaming(messageId));
}

function ordinalOf(metadata, tagId) {
  const legacyTag = legacyTagOf(metadata, tagId);
  if (legacyTag && Number.isInteger(legacyTag.ordinal)) return legacyTag.ordinal;
  return metadataTagIds(metadata).indexOf(tagId);
}

/* 在聊天里找标签，并说明它现在在哪：
   - active：某一层当前显示的那一版；
   - swipe：同一层另一个滑动版本的存档。酒馆滑走时把整份 extra 深拷贝进 swipe_info[旧版].extra 再换上另一版，
     引用跟着拷过去，记录在侧文件里按 tagId 放着，滑回去照样找得到。
   当前显示那一版自己的存档是过期拷贝，不算；正在生成新滑动版本时，这一层的 extra 还是上一版留下的，
   以上一版的存档为准。都找不到返回 null：消息被重新生成、删除、改动过，或者已经切到了别的聊天。
   返回里带 ordinal 和 prompt（从对应那一版的正文里解析；旧格式退回楼里存的那份）。 */
export function locateTag(chat, tagId, { isStreaming = () => false } = {}) {
  const messages = Array.isArray(chat) ? chat : [];
  let active = null;
  for (const [messageId, message] of messages.entries()) {
    const metadata = message?.extra?.stImageAtelier;
    if (!metadataTagIds(metadata).includes(tagId)) continue;
    const legacyTag = legacyTagOf(metadata, tagId);
    const ordinal = ordinalOf(metadata, tagId);
    active = {
      message,
      metadata,
      placement: 'active',
      swipeId: null,
      ordinal,
      prompt: promptAt(message.mes, ordinal, legacyTag?.prompt || ''),
      tag: legacyTag,
    };
    if (!showsPreviousSwipe(message, messageId, isStreaming)) return active;
    break;
  }
  for (const message of messages) {
    if (!Array.isArray(message?.swipe_info)) continue;
    for (const [swipeId, swipe] of message.swipe_info.entries()) {
      if (swipeId === message.swipe_id) continue;
      const metadata = swipe?.extra?.stImageAtelier;
      if (!metadataTagIds(metadata).includes(tagId)) continue;
      const legacyTag = legacyTagOf(metadata, tagId);
      const ordinal = ordinalOf(metadata, tagId);
      const text = Array.isArray(message.swipes) ? message.swipes[swipeId] : undefined;
      return {
        message,
        metadata,
        placement: 'swipe',
        swipeId,
        ordinal,
        prompt: promptAt(text, ordinal, legacyTag?.prompt || ''),
        tag: legacyTag,
      };
    }
  }
  return active;
}
