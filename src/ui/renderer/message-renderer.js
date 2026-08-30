import { createCard } from './card.js';

export function findDrawMarkupSpans(text) {
  const pattern = /<draw\b[^>]*>[\s\S]*?<\/draw\s*>/gi;
  const spans = [];
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length, raw: match[0] });
  }
  return spans;
}

function normalizeWithOffsets(value) {
  const text = String(value || '');
  let normalized = '';
  const starts = [];
  const ends = [];
  let pendingWhitespace = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      if (normalized && !normalized.endsWith(' ')) {
        pendingWhitespace ??= index;
      }
      continue;
    }
    if (pendingWhitespace != null) {
      normalized += ' ';
      starts.push(pendingWhitespace);
      ends.push(index);
      pendingWhitespace = null;
    }
    normalized += character;
    starts.push(index);
    ends.push(index + 1);
  }
  return { normalized, starts, ends };
}

export function findNormalizedTextSpan(text, needle, from = 0) {
  const source = normalizeWithOffsets(text);
  const target = normalizeWithOffsets(needle).normalized;
  if (!target) return null;
  const normalizedStart = source.normalized.indexOf(target, Math.max(0, from));
  if (normalizedStart < 0) return null;
  const normalizedEnd = normalizedStart + target.length;
  return {
    start: source.starts[normalizedStart],
    end: source.ends[normalizedEnd - 1],
    normalizedStart,
    normalizedEnd,
  };
}

function visibleTextNodes(container) {
  const nodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.data || node.parentElement?.closest('.stia-card, script, style')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function boundaryAt(nodes, absoluteOffset, side = 'start') {
  let traversed = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const next = traversed + node.data.length;
    const isSharedBoundary = absoluteOffset === next && index < nodes.length - 1;
    if (absoluteOffset < next || (absoluteOffset === next && (side === 'end' || !isSharedBoundary))) {
      return { node, offset: Math.max(0, absoluteOffset - traversed) };
    }
    traversed = next;
  }
  const last = nodes.at(-1);
  return last ? { node: last, offset: last.data.length } : null;
}

function textRanges(container) {
  const nodes = visibleTextNodes(container);
  const combined = nodes.map(node => node.data).join('');
  return findDrawMarkupSpans(combined).map(span => {
    const start = boundaryAt(nodes, span.start, 'start');
    const end = boundaryAt(nodes, span.end, 'end');
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return { range, raw: span.raw };
  }).filter(Boolean);
}

/* 空白无关匹配 —— Claude Opus 5
   酒馆的 HTML 消毒器会把 <draw> 这种未知标签整个剥掉，只留下里面的文字，
   所以 DOM 里既没有 <draw> 元素、文本里也没有字面 <draw>，
   锚点路径和 textRanges 全部落空，只剩这里按文字匹配。

   而这里原本按「空白折叠成一个空格」比对，正好踩中另一个坑：
   提示词里的换行渲染成 <br>，<br> 不是文本节点，DOM 侧拼出来是
   "characters.Refined"（无空格），提示词侧规范化后是 "characters. Refined"（有空格），
   对不上 → 匹配失败 → 卡片落进楼底 fallback，原文一直露着。

   改成两侧空白全部去掉再比，不要求空白对齐。 */
function squeezeWithOffsets(text) {
  let squeezed = '';
  const starts = [];
  const ends = [];
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) continue;
    squeezed += text[index];
    starts.push(index);
    ends.push(index + 1);
  }
  return { squeezed, starts, ends };
}

function promptRanges(container, tags) {
  const nodes = visibleTextNodes(container);
  const combined = nodes.map(node => node.data).join('');
  const normalized = squeezeWithOffsets(combined);
  let cursor = 0;
  return tags.map(tag => {
    const target = squeezeWithOffsets(tag.prompt).squeezed;
    if (!target) return null;
    let normalizedStart = normalized.squeezed.indexOf(target, cursor);
    if (normalizedStart < 0) normalizedStart = normalized.squeezed.indexOf(target);
    if (normalizedStart < 0) return null;
    const normalizedEnd = normalizedStart + target.length;
    cursor = normalizedEnd;
    const startOffset = normalized.starts[normalizedStart];
    const endOffset = normalized.ends[normalizedEnd - 1];
    const start = boundaryAt(nodes, startOffset, 'start');
    const end = boundaryAt(nodes, endOffset, 'end');
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return { range, raw: tag.prompt };
  });
}

function comparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/* 跨段落残肢清扫 —— Claude Opus 5
   提示词模板里若有空行，酒馆会把它渲染成多个 <p>。<draw> 是未知元素，
   HTML 解析器在第一个 </p> 处就把它隐式闭合了，于是 <draw> 只包住第一行，
   后面几段变成裸段落——卡片替换掉那个小 <draw> 就收工，剩下的英文一直露在外面，
   而且不属于任何 <draw>，孤儿检查也发现不了。
   这里在换完锚点之后，按 prompt 余下的部分在 DOM 里扫一遍，把残肢一并吃掉。
   只删与 prompt 逐字对得上的文本，绝不碰正文。 */
function sweepSplitRemains(container, prompt) {
  const target = comparableText(prompt);
  if (!target) return 0;

  let removed = 0;
  for (let guard = 0; guard < 40; guard += 1) {
    const paragraphs = [...container.querySelectorAll('p')]
      .filter(node => !node.closest('.stia-card') && node.textContent.trim());
    const doomed = paragraphs.find(node => {
      const text = comparableText(node.textContent);
      return text.length > 0 && target.includes(text);
    });
    if (!doomed) break;
    doomed.remove();
    removed += 1;
  }
  return removed;
}

function replaceRange(range, replacement, raw) {
  const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const paragraph = common?.closest?.('p');
  if (paragraph
    && !paragraph.closest('.stia-card')
    && comparableText(paragraph.textContent) === comparableText(raw || range.toString())) {
    paragraph.replaceWith(replacement);
    return;
  }
  range.deleteContents();
  range.insertNode(replacement);
}

export function createMessageRenderer(dependencies) {
  const { compat, api, store, actions } = dependencies;
  const cards = new Map();

  function stateFor(tagId) {
    return store.state.tagStates.get(tagId);
  }

  function makeCard(tag) {
    const card = createCard({
      tag,
      api,
      getState: stateFor,
      onGenerate: actions.generate,
      onOpenGallery: actions.openGallery,
      onCancel: actions.cancel,
    });
    cards.set(tag.tagId, card);
    card.render();
    return card;
  }

  function mount(messageId, tags) {
    const message = compat.messageElement(messageId);
    const container = message?.querySelector('.mes_text');
    if (!container) return { mounted: 0, fallback: 0 };

    const drawElements = [...container.querySelectorAll('draw')]
      .filter(element => !element.closest('.stia-card'));

    /* 改写抢跑修补 —— Claude Opus 5
       MESSAGE_EDITED 会赶在酒馆用 mes 重建这一层 DOM 之前到达。那一刻旧 DOM 里
       卡片还在，下面这个 missing 判断就是空的，于是整个 mount 直接 return；
       等重建真的发生，<draw> 元素回来了、卡片没了，而事件已经消耗掉，再没人来收拾，
       结果就是原文一直露着、图卡掉到楼底。

       判断的前提本来就错了：它问的是「每个 tag 是不是都有卡了」，
       而真正要守的不变量是「DOM 里不许留下没被替换的 <draw> 元素」。
       平时两者等价，重建那一瞬间不等价。所以只要还有孤儿 <draw>，就不许提前退出。 */
    let missing = tags
      .map((tag, index) => ({ tag, index }))
      .filter(({ tag }) =>
        !container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tag.tagId)}"]`));

    if (drawElements.length) {
      /* 还有没被替换的 <draw>，说明这一层是坏的：多半是上一轮落进了楼底的
         fallback 列表，卡片"存在"但没长在原地。此时 missing 会算成空，
         整个 mount 提前退出 —— 于是原文一直露着、再也回不去。
         把错位的卡片摘掉，全部 tag 重新当作待挂载，让锚点路径接管。 */
      for (const { tagId } of tags) {
        const stale = container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tagId)}"]`);
        if (stale) stale.remove();
      }
      const emptyList = container.querySelector(':scope > .stia-card-list');
      if (emptyList && !emptyList.querySelector('.stia-card')) emptyList.remove();
      missing = tags.map((tag, index) => ({ tag, index }));
    }

    if (!missing.length) return { mounted: 0, fallback: 0 };
    let unresolved = missing;
    let mounted = 0;
    if (drawElements.length) {
      const anchored = unresolved.slice(0, drawElements.length);
      for (const [{ tag }, anchor] of anchored.map((item, index) => [item, drawElements[index]])) {
        if (!anchor) continue;
        const card = makeCard(tag);
        anchor.replaceWith(card.root);
        sweepSplitRemains(container, tag.prompt);
        mounted += 1;
      }
      unresolved = unresolved.slice(anchored.length);
      if (!unresolved.length) return { mounted, fallback: 0 };
    }

    const ranges = textRanges(container);
    const replacements = unresolved
      .map(({ tag }, index) => ({
        tag,
        range: ranges[index]?.range,
        raw: ranges[index]?.raw,
      }))
      .filter(item => item.range);
    for (const { tag, range, raw } of replacements.reverse()) {
      const card = makeCard(tag);
      replaceRange(range, card.root, raw);
    }

    mounted += replacements.length;
    const mountedIds = new Set(replacements.map(item => item.tag.tagId));
    unresolved = unresolved.filter(({ tag }) => !mountedIds.has(tag.tagId)
      && !container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tag.tagId)}"]`));
    if (!unresolved.length) return { mounted, fallback: 0 };

    const promptMatches = promptRanges(container, unresolved.map(item => item.tag));
    const promptReplacements = unresolved
      .map(({ tag }, index) => ({
        tag,
        range: promptMatches[index]?.range,
        raw: promptMatches[index]?.raw,
      }))
      .filter(item => item.range);
    for (const { tag, range, raw } of promptReplacements.reverse()) {
      const card = makeCard(tag);
      replaceRange(range, card.root, raw);
    }
    mounted += promptReplacements.length;
    const promptMountedIds = new Set(promptReplacements.map(item => item.tag.tagId));
    unresolved = unresolved.filter(({ tag }) => !promptMountedIds.has(tag.tagId)
      && !container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tag.tagId)}"]`));
    if (!unresolved.length) return { mounted, fallback: 0 };

    let fallback = container.querySelector(':scope > .stia-card-list');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.className = 'stia-card-list';
      container.append(fallback);
    }
    for (const { tag } of unresolved) fallback.append(makeCard(tag).root);
    return { mounted, fallback: unresolved.length };
  }

  function renderTag(tagId) {
    cards.get(tagId)?.render();
  }

  store.subscribe(() => {
    for (const card of cards.values()) {
      if (card.root.isConnected) card.render();
    }
  });

  return { mount, renderTag };
}
