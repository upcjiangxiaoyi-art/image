import { parseDrawTags } from '../parser/draw-parser.js';
import { isLegacyMetadata, legacyTagOf, metadataTagIds } from './tag-identity.js';

/* 一键删除生图标签：从消息原文里连同 <draw>…</draw> 一起摘掉，不留痕迹。
   - 正文里只删这一个标签的字面范围，前后多余的空行一并收掉，其余一个字不碰。
   - 酒馆左右滑时会用 swipes[swipe_id] 覆盖 mes，只改 mes 一滑回来标签又长回来，两边同步。
   - 引用里的这个 tagId 摘掉；一条不剩时整个命名空间删掉。旧格式的楼照旧摘掉那条标签并重排 ordinal。 */

function cutSpan(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const leading = before.match(/\s*$/)[0];
  const trailing = after.match(/^\s*/)[0];
  const head = before.slice(0, before.length - leading.length);
  const tail = after.slice(trailing.length);
  if (!head || !tail) return head + tail;
  const hadLineBreak = /\n/.test(leading) || /\n/.test(trailing);
  if (hadLineBreak) {
    const blankLine = /\n[ \t]*\n/.test(leading) || /\n[ \t]*\n/.test(trailing);
    return `${head}${blankLine ? '\n\n' : '\n'}${tail}`;
  }
  return `${head} ${tail}`;
}

function locateSpan(text, { ordinal, prompt }) {
  const parsed = parseDrawTags(text, { warn: () => {} });
  const byOrdinal = parsed[ordinal];
  if (byOrdinal && (prompt == null || byOrdinal.prompt === prompt)) return byOrdinal;
  return prompt == null ? null : parsed.find(item => item.prompt === prompt) || null;
}

export function stripDrawTag(text, target) {
  const source = String(text ?? '');
  const span = locateSpan(source, target);
  if (!span) return { text: source, removed: false };
  return { text: cutSpan(source, span.start, span.end), removed: true };
}

/* prompt 可选：引用格式的楼里不存提示词，从正文按位置解析；传了就按传的认。 */
export function removeDrawTagFromMessage(message, tagId, { prompt: knownPrompt } = {}) {
  if (!message || typeof message.mes !== 'string') return { changed: false, tag: null };
  const metadata = message.extra?.stImageAtelier;
  const ids = metadataTagIds(metadata);
  const index = ids.indexOf(tagId);
  if (index < 0) return { changed: false, tag: null };
  const legacyTag = legacyTagOf(metadata, tagId);
  const ordinal = Number.isInteger(legacyTag?.ordinal) ? legacyTag.ordinal : index;
  const prompt = typeof knownPrompt === 'string'
    ? knownPrompt
    : (legacyTag?.prompt ?? parseDrawTags(message.mes, { warn: () => {} })[ordinal]?.prompt ?? null);
  const target = { ordinal, prompt };

  const previous = message.mes;
  const stripped = stripDrawTag(previous, target);
  message.mes = stripped.text;

  if (Array.isArray(message.swipes)) {
    message.swipes = message.swipes.map(swipe => {
      if (typeof swipe !== 'string') return swipe;
      if (swipe === previous) return message.mes;
      return stripDrawTag(swipe, target).text;
    });
  }

  if (isLegacyMetadata(metadata)) {
    const remaining = metadata.tags
      .filter(tag => tag?.tagId !== tagId)
      .map((item, position) => ({ ...item, ordinal: position }));
    if (remaining.length) message.extra.stImageAtelier = { ...metadata, tags: remaining };
    else delete message.extra.stImageAtelier;
  } else {
    const remaining = ids.filter(id => id !== tagId);
    if (remaining.length) message.extra.stImageAtelier = { messageUuid: metadata.messageUuid, tagIds: remaining };
    else delete message.extra.stImageAtelier;
  }
  return {
    changed: true,
    tag: legacyTag || { tagId, ordinal, prompt: prompt ?? '' },
    removedMarkup: stripped.removed,
  };
}
