/* 聊天里一个生图标签存什么、怎么存。
   楼层的 extra.stImageAtelier.tags[i] 只放轻量引用：
     tagId、prompt（只存这一份）、ordinal / ratio / quality / count、latestResultId、
     resultRefs（每张图只记 resultId、服务器上的路径、时间）、autoAttempted / autoSuppressed。
   生成记录（谁画的、画了多久、报了什么错）在独立文件里，按 tagId 关联（attempt-store.js）；
   图片本身的元数据在画廊文件里。Base64、原始 API 响应、提示词的复制品一律不进聊天。
   旧版把整份 attempts / results 复制在聊天里，还用 resultIds 存图片 id：这些字段只在旧数据里
   还有时原样带着，等搬走后删掉。 */

export const MAX_RESULTS_PER_TAG = 10;

/* 字段顺序固定：识别消息时会用 JSON 比对有没有改动，顺序不一样就会被当成改动、整份聊天多保存一遍。
   所有改写标签的地方都经过 canonicalTag，内存里和文件里的顺序才一致。 */
export const TAG_KEY_ORDER = Object.freeze([
  'tagId', 'prompt', 'ordinal', 'ratio', 'quality', 'count', 'latestResultId',
  'resultIds', 'attempts', 'results',
  'resultRefs', 'autoAttempted', 'autoSuppressed',
]);
const LEGACY_KEYS = Object.freeze(['resultIds', 'attempts', 'results']);
/* 生成记录里这些字段都是提示词的复制品：画师串整段、拼好的最终提示词。基础提示词在标签里，
   画师串在画廊记录里，都能找回来，不用每次生成各存一份。 */
const HEAVY_ATTEMPT_KEYS = Object.freeze([
  'resolvedPrompt', 'resolvedNegativePrompt', 'artistPromptSnapshot', 'artistNegativePromptSnapshot',
]);
const ERROR_MESSAGE_LIMIT = 400;
const STATUS_MESSAGE_LIMIT = 200;

export function canonicalTag(tag) {
  const next = {};
  for (const key of TAG_KEY_ORDER) {
    if (Object.hasOwn(tag, key) && tag[key] !== undefined) next[key] = tag[key];
  }
  return next;
}

/* 原地改写：聊天数组里的还是同一个对象，谁拿着引用都不会断。 */
export function rebuildInPlace(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
  return target;
}

export function hasLegacyFields(tag) {
  return LEGACY_KEYS.some(key => Object.hasOwn(tag || {}, key));
}

export function hasLegacyAttempts(tag) {
  return Array.isArray(tag?.attempts);
}

/* 这个标签引用的图片 id，按顺序：精简形看 resultRefs，旧数据看 resultIds。 */
export function tagResultIds(tag) {
  if (Array.isArray(tag?.resultRefs)) {
    return [...new Set(tag.resultRefs.map(ref => ref?.resultId).filter(Boolean))];
  }
  return Array.isArray(tag?.resultIds) ? [...new Set(tag.resultIds.filter(Boolean))] : [];
}

export function refFromRecord(record, previous = null) {
  return {
    resultId: record.resultId,
    path: String(record.localRelativePath || previous?.path || ''),
    createdAt: String(record.createdAt || previous?.createdAt || ''),
  };
}

/* 按给定顺序重写图片引用。有画廊记录的从记录取路径和时间；没有记录但原来就是带路径的引用照留
   （画廊索引丢了，瘦身时还能按路径找回来）；旧版只有 id、又没有记录的丢掉。 */
export function buildResultRefs(tag, orderedIds, lookup) {
  const previous = new Map(
    (Array.isArray(tag?.resultRefs) ? tag.resultRefs : [])
      .filter(ref => ref?.resultId)
      .map(ref => [ref.resultId, ref]),
  );
  const refs = [];
  const seen = new Set();
  for (const resultId of orderedIds || []) {
    if (!resultId || seen.has(resultId)) continue;
    seen.add(resultId);
    const record = lookup(resultId);
    const kept = previous.get(resultId);
    if (record) refs.push(refFromRecord(record, kept));
    else if (kept?.path) refs.push({ resultId, path: String(kept.path), createdAt: String(kept.createdAt || '') });
  }
  return refs;
}

/* 有画廊记录、卡片上能显示的那些。 */
export function displayableResultIds(tag, lookup) {
  return tagResultIds(tag).filter(resultId => Boolean(lookup(resultId)));
}

export function normalizeLatestResultId(tag, lookup) {
  const displayable = displayableResultIds(tag, lookup);
  return displayable.includes(tag?.latestResultId) ? tag.latestResultId : displayable.at(-1) || null;
}

/* 把标签改写成精简形（原地）：图片引用按 orderedIds 重建，旧版的 resultIds / results 去掉。
   旧版的 attempts 只在还有内容、没搬进独立存储时保留（搬完由调用方删）；空的直接去掉。 */
export function writeTagResults(tag, orderedIds, lookup) {
  const refs = buildResultRefs(tag, orderedIds, lookup);
  return rebuildInPlace(tag, canonicalTag({
    ...tag,
    resultIds: undefined,
    attempts: Array.isArray(tag.attempts) && tag.attempts.length ? tag.attempts : undefined,
    results: undefined,
    resultRefs: refs,
  }));
}

/* 瘦身用：返回一个标签的精简形（新对象，不带任何旧版字段）。dropDangling 里的引用确认文件已经不在，丢掉。 */
export function leanTag(tag, lookup, { dropDangling = new Set() } = {}) {
  const refs = buildResultRefs(tag, tagResultIds(tag), lookup)
    .filter(ref => !dropDangling.has(ref.resultId));
  const displayable = refs.filter(ref => Boolean(lookup(ref.resultId))).map(ref => ref.resultId);
  const latestResultId = displayable.includes(tag?.latestResultId)
    ? tag.latestResultId
    : displayable.at(-1) || null;
  return canonicalTag({
    tagId: tag.tagId,
    prompt: tag.prompt,
    ordinal: tag.ordinal,
    ratio: tag.ratio,
    quality: tag.quality,
    count: tag.count,
    latestResultId,
    resultRefs: refs,
    autoAttempted: Boolean(tag.autoAttempted),
    autoSuppressed: Boolean(tag.autoSuppressed),
  });
}

/* 超过每张卡的上限时先删哪些：没有画廊记录的空引用先走（没有文件可删），然后是最早的、没收藏的；
   刚画好的（protect）和收藏的不动。返回要删的引用，按删除顺序。 */
export function selectResultEvictions(refs, lookup, { limit = MAX_RESULTS_PER_TAG, protect = new Set() } = {}) {
  const list = Array.isArray(refs) ? refs.filter(ref => ref?.resultId) : [];
  const excess = list.length - limit;
  if (excess <= 0) return [];
  const dangling = list.filter(ref => !lookup(ref.resultId) && !protect.has(ref.resultId));
  const deletable = list.filter(ref => {
    const record = lookup(ref.resultId);
    return record && record.favorite !== true && !protect.has(ref.resultId);
  });
  return [...dangling, ...deletable].slice(0, excess);
}

/* 写进独立存储之前把生成记录精简：去掉提示词的复制品；和标签一样的基础提示词也不存
   （读出来时补回去），只有「调整后重绘」用的临时提示词才留。报错原文截到 400 字。 */
export function slimAttempt(attempt, tagPrompt) {
  const slim = { ...attempt };
  for (const key of HEAVY_ATTEMPT_KEYS) delete slim[key];
  if (typeof tagPrompt === 'string' && slim.promptSnapshot === tagPrompt) delete slim.promptSnapshot;
  if (typeof slim.errorMessage === 'string' && slim.errorMessage.length > ERROR_MESSAGE_LIMIT) {
    slim.errorMessage = `${slim.errorMessage.slice(0, ERROR_MESSAGE_LIMIT)}…`;
  }
  if (typeof slim.statusMessage === 'string' && slim.statusMessage.length > STATUS_MESSAGE_LIMIT) {
    slim.statusMessage = slim.statusMessage.slice(0, STATUS_MESSAGE_LIMIT);
  }
  return slim;
}

/* 读出来给卡片用：没存 promptSnapshot 的就是用的标签本身的提示词。 */
export function hydrateAttempt(attempt, tagPrompt) {
  if (!attempt || typeof tagPrompt !== 'string' || Object.hasOwn(attempt, 'promptSnapshot')) return attempt;
  return { ...attempt, promptSnapshot: tagPrompt };
}
