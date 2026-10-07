/* 聊天里生图标签数据的体积：瘦身前后在控制台报数、写入前超过上限就警告。
   酒馆保存聊天是整份上传、重写、备份，楼层的 extra 一胖，每次保存都拖垮服务端。 */

export const TAG_BYTES_WARN_LIMIT = 20 * 1024;

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

export function byteLength(value) {
  if (value === undefined) return 0;
  const text = JSON.stringify(value);
  if (text == null) return 0;
  if (encoder) return encoder.encode(text).length;
  return globalThis.Buffer ? globalThis.Buffer.byteLength(text, 'utf8') : text.length;
}

export function describeBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function tagsBytes(metadata) {
  return Array.isArray(metadata?.tags) ? byteLength(metadata.tags) : 0;
}

/* 一个标签各字段的字节数，大的在前。 */
export function fieldSizes(tag) {
  const entries = Object.entries(tag || {})
    .map(([key, value]) => [key, byteLength(value)])
    .sort((left, right) => right[1] - left[1]);
  return Object.fromEntries(entries);
}

/* 一楼的标签数据：当前显示的这一版（active）和滑动存档 swipe_info[].extra 里的副本（swipes）。 */
export function messageTagsFootprint(message) {
  const active = tagsBytes(message?.extra?.stImageAtelier);
  let swipes = 0;
  for (const swipe of Array.isArray(message?.swipe_info) ? message.swipe_info : []) {
    swipes += tagsBytes(swipe?.extra?.stImageAtelier);
  }
  return {
    active,
    swipes,
    total: active + swipes,
    tags: Array.isArray(message?.extra?.stImageAtelier?.tags) ? message.extra.stImageAtelier.tags.length : 0,
  };
}

export function chatTagsFootprint(chat) {
  const summary = {
    bytes: 0,
    activeBytes: 0,
    swipeBytes: 0,
    messages: 0,
    tags: 0,
    heaviest: null,
  };
  for (const [messageId, message] of (Array.isArray(chat) ? chat : []).entries()) {
    const footprint = messageTagsFootprint(message);
    if (!footprint.total && !footprint.tags) continue;
    summary.bytes += footprint.total;
    summary.activeBytes += footprint.active;
    summary.swipeBytes += footprint.swipes;
    summary.messages += 1;
    summary.tags += footprint.tags;
    if (!summary.heaviest || footprint.total > summary.heaviest.bytes) {
      summary.heaviest = { messageId, bytes: footprint.total };
    }
  }
  return summary;
}

export function describeFootprint(summary) {
  return `${describeBytes(summary.bytes)}（${summary.messages} 楼、${summary.tags} 个标签；`
    + `当前版本 ${describeBytes(summary.activeBytes)}，滑动存档 ${describeBytes(summary.swipeBytes)}）`;
}

/* 写入前的检查：这一楼当前版本的 tags 序列化后超过 20 KB 就 console.warn，并列出每个标签各字段的大小。 */
export function warnIfHeavy(message, messageId, { limit = TAG_BYTES_WARN_LIMIT, warn = console.warn } = {}) {
  const metadata = message?.extra?.stImageAtelier;
  const bytes = tagsBytes(metadata);
  if (bytes <= limit) return { bytes, heavy: false, details: [] };
  const details = (metadata.tags || []).map(tag => ({
    标签: tag?.tagId,
    总计: describeBytes(byteLength(tag)),
    字段: Object.fromEntries(Object.entries(fieldSizes(tag)).map(([key, size]) => [key, describeBytes(size)])),
  }));
  warn(
    `[画笺] 第 ${messageId} 楼的生图标签数据有 ${describeBytes(bytes)}，超过 ${describeBytes(limit)}；各字段大小：`,
    details,
  );
  return { bytes, heavy: true, details };
}
