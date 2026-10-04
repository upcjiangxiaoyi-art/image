import { makeImageSaveable, openImageViewer } from '../media/image-viewer.js';
import { fallbackAdvice } from '../pages/error-dialog/error-dialog.js';

const ACTIVE_STATUSES = new Set(['queued', 'generating', 'downloading', 'saving']);

const STATUS_TEXT = {
  queued: '排队中',
  generating: '正在生成…',
  downloading: '正在下载图片…',
  saving: '正在保存到酒馆…',
  interrupted: '生成被中断',
  cancelled: '已取消',
};

/* 生成计时：整页只开一个每秒一次的定时器，只改计时那几个字，不重画卡片；
   页面上没有在计时的卡片就停，卡片再渲染时重新开。 */
const ELAPSED_SELECTOR = '.stia-card__elapsed[data-since]';
let elapsedTimer = null;

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

export function formatElapsed(milliseconds) {
  return `已用 ${formatDuration(milliseconds)}`;
}

/* 出图后的用时：画出这张图的那一次从开始到存好一共多久。记录不全或时间对不上就不显示。 */
export function generationDuration(attempt) {
  const started = Date.parse(attempt?.createdAt || '');
  const finished = Date.parse(attempt?.completedAt || '');
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return '';
  return `用时 ${formatDuration(finished - started)}`;
}

function updateElapsed(node, current = Date.now()) {
  node.textContent = formatElapsed(current - Number(node.dataset.since));
}

function tickElapsed() {
  const nodes = globalThis.document?.querySelectorAll?.(ELAPSED_SELECTOR) || [];
  if (!nodes.length) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    return;
  }
  const current = Date.now();
  for (const node of nodes) updateElapsed(node, current);
}

function ensureElapsedTicker() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(tickElapsed, 1000);
  elapsedTimer.unref?.();
}

function elapsedLabel(since) {
  const node = document.createElement('span');
  node.className = 'stia-card__elapsed';
  node.setAttribute('role', 'timer');
  node.dataset.since = String(since);
  updateElapsed(node);
  return node;
}

/* 服务端时钟比浏览器快时按现在算，不显示负数。 */
function startedAt(attempt, current = Date.now()) {
  const created = Date.parse(attempt?.createdAt || '');
  return Number.isFinite(created) ? Math.min(created, current) : current;
}

function button(label, className, handler, symbol = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-button ${className || ''}`.trim();
  if (symbol) {
    const icon = document.createElement('span');
    icon.className = 'stia-button__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = symbol;
    element.append(icon);
  }
  const text = document.createElement('span');
  text.textContent = label;
  element.append(text);
  element.addEventListener('click', handler);
  return element;
}

function promptDetails(prompt) {
  const details = document.createElement('details');
  details.className = 'stia-prompt';
  const summary = document.createElement('summary');
  summary.textContent = '◉  查看提示词';
  const text = document.createElement('pre');
  text.textContent = prompt;
  details.append(summary, text);
  return details;
}

function displaySize(value) {
  return String(value || '').replace(/(\d)x(\d)/gi, '$1×$2');
}

/* 卡片下方这张图的信息：用的哪个预设、模型、画质、尺寸。以画出这张图的那一次为准，
   图片记录里有的先用图片记录；旧记录里没有的项不显示。智能重试去掉过的参数显示「默认」。 */
export function imageInfo(result, producer) {
  const novelai = (result?.provider || producer?.provider) === 'novelai';
  const dropped = new Set([
    ...(producer?.compatibilityRetry?.adjustedParameters || []),
    ...(result?.compatibilityRetry?.adjustedParameters || []),
  ]);
  const requested = producer?.qualitySnapshot ?? producer?.parameters?.quality ?? '';
  let quality = '';
  if (!novelai) {
    if (dropped.has('quality')) quality = requested ? `默认（${requested} 被拒）` : '默认';
    else if (typeof producer?.qualitySnapshot === 'string') quality = producer.qualitySnapshot || '默认';
    else quality = String(producer?.parameters?.quality || '');
  }
  return {
    presetLabel: novelai ? '画师串' : '预设',
    preset: novelai
      ? (result?.artistPresetNameSnapshot || producer?.artistPresetNameSnapshot || '')
      : (result?.presetNameSnapshot || producer?.presetNameSnapshot || ''),
    model: result?.apiModel || producer?.model || '',
    quality,
    size: dropped.has('size') ? '默认尺寸' : displaySize(producer?.parameters?.size || ''),
  };
}

function infoList(info) {
  /* GPT 的图总给一个画质栏：1.6.18 之前画的图没记实际发出去的画质，写「未记录」，
     不让这一栏时有时无。什么记录都没有的老图片整块不显示。 */
  const known = Boolean(info.preset || info.model);
  const qualityUnknown = !info.quality && known && info.presetLabel === '预设';
  const items = [
    [info.presetLabel, info.preset, 'is-start'],
    ['画质', qualityUnknown ? '未记录' : info.quality, 'is-end'],
    ['模型', info.model, 'is-wide'],
  ].filter(([, value]) => value);
  if (!items.length) return null;
  const list = document.createElement('dl');
  list.className = 'stia-card__info';
  for (const [label, value, modifier] of items) {
    const item = document.createElement('div');
    item.className = `stia-card__info-item ${modifier}`;
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    if (label === '画质' && qualityUnknown) detail.className = 'is-unknown';
    item.append(term, detail);
    list.append(item);
  }
  return list;
}

function navButton(symbol, label, className, handler) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-card__nav ${className}`;
  element.textContent = symbol;
  element.setAttribute('aria-label', label);
  element.addEventListener('click', event => {
    event?.stopPropagation();
    handler();
  });
  return element;
}

function statusHeading(symbol, title, subtitle, tone = '') {
  const heading = document.createElement('div');
  heading.className = `stia-card__status ${tone}`.trim();
  const icon = document.createElement('span');
  icon.className = 'stia-card__status-icon';
  icon.textContent = symbol;
  const copy = document.createElement('span');
  copy.className = 'stia-card__status-text';
  const strong = document.createElement('strong');
  strong.textContent = title;
  copy.append(strong);
  if (subtitle) {
    const small = document.createElement('small');
    small.textContent = subtitle;
    copy.append(small);
  }
  heading.append(icon, copy);
  return heading;
}

export function createCard({
  tag,
  api,
  getState,
  getSettings = () => ({}),
  onGenerate,
  onAdjustRegenerate,
  onOpenGallery,
  onCancel,
  onRemove,
  onReroll,
  onFallback,
  listPresets,
}) {
  const root = document.createElement('section');
  root.className = 'stia-card';
  root.dataset.tagId = tag.tagId;
  root.setAttribute('aria-label', '画笺生图卡片');

  /* 一键删除：卡片、消息里的 <draw> 注入词、标签元数据一起清掉，不留痕迹。
     只在失败和待生成两种状态提供；已出图的走画廊删除，生成中的先取消。 */
  function removeButton() {
    return button('删除', 'stia-button--ghost stia-card__remove', () => onRemove(tag), '×');
  }

  /* 渲染器在任何一张卡有动静时都会把所有卡片重画一遍。画面没变就不重建 DOM；要重建时，
     同一张图沿用原来那个已经加载、解码好的 <img>。不然每次都换新元素，图片重新加载，
     看起来就是在闪，展开的「查看提示词」也会被收起。 */
  let lastSignature = null;
  /* 按地址缓存这张卡的 <img>：同一张图沿用已经加载、解码好的元素，左右翻看来回切也不重新加载。 */
  const imageCache = new Map();
  let openCurrentImage = null;
  /* 在卡片上翻看这张卡的其他图：viewingId 是正在看的那张；只是看，不改记录里显示哪张，
     有新图画好时回到新图。翻过一次以后其余几张在后台先加载好。 */
  let viewingId = null;
  let lastLatestId = null;
  let preloadOthers = false;
  let navigation = null;
  let timerNodes = [];
  let timing = null;
  /* 选用哪个 API 预设：生成中的「再画一张」（mode 'reroll'，正在画的留在后台）和出图后的
     「重新生成」（mode 'regenerate'）共用。presets 为 null 时正在读取；originalId 是画出这张图的预设。 */
  let chooser = null;

  /* 从这次生成开始时算起；同一次生成里状态怎么变都不重新计时。 */
  function elapsedSince(attempt) {
    if (!timing || timing.attemptId !== attempt.attemptId) {
      timing = { attemptId: attempt.attemptId, since: startedAt(attempt) };
    }
    return timing.since;
  }

  function imageFor(source, { eager = false } = {}) {
    let image = imageCache.get(source);
    if (!image) {
      image = document.createElement('img');
      image.className = 'stia-card__image';
      image.loading = eager ? 'eager' : 'lazy';
      image.src = source;
      makeImageSaveable(image, () => openCurrentImage?.());
      imageCache.set(source, image);
    }
    return image;
  }

  function step(delta) {
    if (!navigation || navigation.ids.length < 2) return;
    const { ids, index } = navigation;
    viewingId = ids[(index + delta + ids.length) % ids.length];
    preloadOthers = true;
    render();
  }

  function timer(since) {
    const node = elapsedLabel(since);
    timerNodes.push(node);
    ensureElapsedTicker();
    return node;
  }

  /* GPT 有好几个 API 预设时先选用哪个（换 key、换分组）：
     - 「再画一张」：只有一个或用 NovelAI 时确认一下就画，正在画的那张留在后台接着画；
     - 「重新生成」：画出这张图的「原渠道」排第一；只有一个预设、NovelAI 或增强模式时和以前一样点了就画。 */
  function openChooser(mode, { attemptId = null, originalId = '' } = {}) {
    chooser = { mode, attemptId, originalId, presets: null };
    render();
    const wantsPresets = getSettings()?.generationProvider !== 'novelai' && typeof listPresets === 'function';
    Promise.resolve(wantsPresets ? listPresets() : [])
      .catch(() => [])
      .then(presets => {
        if (chooser?.mode !== mode || chooser.attemptId !== attemptId) return;
        const list = Array.isArray(presets) ? presets : [];
        if (mode === 'regenerate' && list.length < 2) {
          chooser = null;
          render();
          void Promise.resolve(onGenerate(tag, 'manual')).catch(() => {});
          return;
        }
        const rank = item => {
          if (mode === 'regenerate' && item.id === originalId) return 0;
          return item.active ? 1 : item.backup ? 2 : 3;
        };
        chooser = { mode, attemptId, originalId, presets: [...list].sort((left, right) => rank(left) - rank(right)) };
        render();
      });
  }

  function closeChooser() {
    chooser = null;
    render();
  }

  function startReroll(attempt, preset) {
    chooser = null;
    render();
    void Promise.resolve(onReroll(tag, attempt.attemptId, preset)).catch(() => {});
  }

  function startRegenerate(preset) {
    chooser = null;
    render();
    void Promise.resolve(onGenerate(tag, 'manual', { preset })).catch(() => {});
  }

  function presetLabel(preset) {
    const original = chooser.mode === 'regenerate' && preset.id === chooser.originalId;
    return `${preset.name}${original ? '（原渠道）' : ''}${preset.active && !original ? '（当前）' : ''}`
      + `${preset.backup ? '（备用）' : ''}${preset.hasApiKey === false ? '（没填 Key）' : ''}`;
  }

  function rerollChooser(attempt) {
    const box = document.createElement('div');
    box.className = 'stia-card__reroll';
    const note = document.createElement('p');
    note.className = 'stia-muted';
    const actions = document.createElement('div');
    actions.className = 'stia-actions stia-actions--fill';
    const presets = chooser.presets;
    const regenerate = chooser.mode === 'regenerate';
    if (presets === null) {
      note.textContent = '正在读取 API 预设…';
    } else if (presets.length > 1) {
      note.textContent = regenerate ? '用哪个预设重新生成？' : '这张会在后台接着画。用哪个预设再画一张？';
      for (const preset of presets) {
        actions.append(button(
          presetLabel(preset),
          'stia-card__reroll-preset',
          () => (regenerate ? startRegenerate(preset) : startReroll(attempt, preset)),
        ));
      }
    } else {
      note.textContent = '这张会在后台接着画，确定再画一张？';
      actions.append(button('确定再画一张', 'stia-button--primary', () => startReroll(attempt, presets[0]), '↻'));
    }
    actions.append(button('算了', 'stia-button--ghost stia-card__reroll-close', closeChooser));
    box.append(note, actions);
    return box;
  }

  /* 之后又 roll 过、还在后台画的那几张：说一声有几张、最早那张画了多久。 */
  function backgroundNote(running) {
    const note = document.createElement('div');
    note.className = 'stia-card__background';
    const text = document.createElement('span');
    text.textContent = `后台还有 ${running.length} 张在画 · `;
    const oldest = Math.min(...running.map(item => startedAt(item)));
    note.append(text, timer(oldest));
    return note;
  }

  function render() {
    const state = getState(tag.tagId) || {};
    const attempt = state.attempts?.[0];
    const available = (state.results || []).filter(result => result.status === 'available');
    const latest = available.find(result => result.resultId === state.tag?.latestResultId)
      || available.at(-1);
    if ((latest?.resultId || null) !== lastLatestId) {
      lastLatestId = latest?.resultId || null;
      viewingId = null;
    }
    /* 卡片上显示、下面信息跟着的那张：在翻看就是正在看的，不然是最新那张。 */
    const shown = (viewingId && available.find(result => result.resultId === viewingId)) || latest;
    const shownIndex = shown ? available.indexOf(shown) : -1;
    const actualPrompt = shown?.prompt
      || shown?.promptSnapshot
      || attempt?.promptSnapshot
      || attempt?.resolvedPrompt
      || tag.prompt;
    const actualNegativePrompt = shown?.negativePrompt
      || shown?.negativePromptSnapshot
      || attempt?.negativePromptSnapshot
      || '';
    const canAdjust = getSettings()?.enablePromptOverrideRegenerate === true
      && typeof onAdjustRegenerate === 'function';
    const size = displaySize(attempt?.parameters?.size || '');
    const ratioLabel = {
      square: '方形',
      portrait: '竖图',
      landscape: '横图',
    }[tag.ratio] || '';
    const src = shown ? api.fileUrl(shown.resultId) : '';
    const producer = shown
      ? (state.attempts || []).find(item => item.attemptId === shown.attemptId)
      : null;
    const duration = shown ? generationDuration(producer) : '';
    const info = shown ? imageInfo(shown, producer) : null;
    /* 图片角上的尺寸跟着这张图；没有生成记录的老图片退回用最近那次的。 */
    const imageSize = info ? (info.size === '默认尺寸' ? '' : info.size || size) : '';
    const running = (state.attempts || []).slice(1).filter(item => ACTIVE_STATUSES.has(item.status));
    /* 失败的卡片上给「换备用线路」：设了备用线路、这次用的不是它、不是 NovelAI 也不在增强模式，
       而且不是审核拦截（换了也照样被拦）或用户自己取消的。 */
    const settings = getSettings() || {};
    const canUseBackup = typeof onFallback === 'function'
      && Boolean(settings.backupPresetId)
      && settings.executionMode !== 'server'
      && settings.generationProvider !== 'novelai'
      && ['failed', 'interrupted'].includes(attempt?.status)
      && attempt?.provider !== 'novelai'
      && attempt?.presetId !== settings.backupPresetId
      && fallbackAdvice({ attempt }).manual;
    /* 卡片换了状态（开始画了、画完了），对应的选择就收起。 */
    const chooserStale = chooser?.mode === 'regenerate'
      ? (!shown || ACTIVE_STATUSES.has(attempt?.status))
      : chooser && (chooser.attemptId !== attempt?.attemptId || !ACTIVE_STATUSES.has(attempt?.status));
    if (chooserStale) chooser = null;
    const signature = JSON.stringify([
      attempt?.attemptId, attempt?.status, attempt?.requestMode, attempt?.statusMessage,
      attempt?.model, attempt?.provider, attempt?.errorMessage, size,
      shown?.resultId, shown?.provider, src, available.map(result => result.resultId), shownIndex,
      Boolean(state.tag?.resultIds?.length), actualPrompt, actualNegativePrompt, canAdjust, ratioLabel,
      running.map(item => item.attemptId), chooser && [chooser.mode, chooser.attemptId, chooser.presets], duration,
      info, imageSize, canUseBackup,
    ]);
    if (signature === lastSignature) {
      /* 卡片被摘下又放回（酒馆重建这一层）时计时可能停了，顺手续上。 */
      if (timerNodes.length) {
        timerNodes.forEach(node => updateElapsed(node));
        ensureElapsedTicker();
      }
      return;
    }
    lastSignature = signature;
    timerNodes = [];
    root.replaceChildren();
    root.className = 'stia-card';

    if (attempt && ACTIVE_STATUSES.has(attempt.status)) {
      const body = document.createElement('div');
      body.className = 'stia-card__body';
      const isAutoQueue = attempt.status === 'queued' && attempt.requestMode === 'auto';
      const isRegenerating = Boolean(latest) && !isAutoQueue;
      root.classList.add(isAutoQueue ? 'stia-card--queued' : 'stia-card--generating');
      const heading = statusHeading(
        isAutoQueue ? '◷' : '◌',
        isAutoQueue
          ? '自动排队中'
          : (isRegenerating ? '正在重新生成…' : (STATUS_TEXT[attempt.status] || '处理中')),
        isAutoQueue
          ? '等待当前生成任务完成'
          : (attempt.statusMessage || `${attempt.model || '当前模型'} · ${size || '默认尺寸'}`),
        isAutoQueue ? 'is-warning' : 'is-accent',
      );
      body.append(heading);
      if (!isAutoQueue) {
        heading.append(timer(elapsedSince(attempt)));
        const shimmer = document.createElement('div');
        shimmer.className = 'stia-card__shimmer';
        body.append(shimmer);
      }
      const canReroll = !isAutoQueue && typeof onReroll === 'function';
      if (canReroll && chooser?.mode === 'reroll') {
        body.append(rerollChooser(attempt));
      } else if (canReroll) {
        const actions = document.createElement('div');
        actions.className = 'stia-actions stia-actions--fill';
        actions.append(
          button('再画一张', '', () => openChooser('reroll', { attemptId: attempt.attemptId }), '↻'),
          button('取消', 'stia-button--ghost', () => onCancel(attempt.attemptId), '×'),
        );
        body.append(actions);
      } else {
        body.append(button(
          isAutoQueue ? '取消排队' : '取消',
          'stia-button--ghost stia-button--full',
          () => onCancel(attempt.attemptId),
          '×',
        ));
      }
      if (running.length) body.append(backgroundNote(running));
      root.append(body);
      return;
    }

    if (shown) {
      root.classList.add('stia-card--succeeded');
      const media = document.createElement('div');
      media.className = 'stia-card__media';
      const sources = available.map(result => api.fileUrl(result.resultId));
      for (const key of imageCache.keys()) {
        if (!sources.includes(key)) imageCache.delete(key);
      }
      const image = imageFor(src);
      if (preloadOthers) sources.forEach(source => imageFor(source, { eager: true }));
      image.alt = actualPrompt.slice(0, 120);
      const openOriginal = () => openImageViewer({
        src,
        alt: image.alt,
        filename: shown.resultId,
        prompt: actualPrompt,
        meta: [info.model, imageSize].filter(Boolean).join(' · '),
      });
      openCurrentImage = openOriginal;
      media.append(image);
      navigation = { ids: available.map(result => result.resultId), index: shownIndex };
      if (available.length > 1) {
        media.append(
          navButton('‹', '上一张', 'is-prev', () => step(-1)),
          navButton('›', '下一张', 'is-next', () => step(1)),
        );
      }
      if (duration) {
        const badge = document.createElement('span');
        badge.className = 'stia-card__duration';
        badge.textContent = duration;
        media.append(badge);
      }
      /* 尺寸在下面「历史 N 张」旁边，图片上不再压一个角标。 */
      const body = document.createElement('div');
      body.className = 'stia-card__body';
      const completion = document.createElement('div');
      completion.className = 'stia-card__completion';
      const done = document.createElement('span');
      done.className = 'stia-success';
      done.textContent = '✓ 已完成';
      const meta = document.createElement('span');
      meta.className = 'stia-card__completion-meta';
      const history = document.createElement('span');
      history.className = 'stia-muted';
      history.textContent = available.length > 1
        ? `第 ${shownIndex + 1} / ${available.length} 张`
        : `历史 ${available.length} 张`;
      meta.append(history);
      const sizeText = info.size || imageSize;
      if (sizeText) {
        const sizeNote = document.createElement('span');
        sizeNote.className = 'stia-card__completion-size';
        sizeNote.textContent = sizeText;
        meta.append(sizeNote);
      }
      completion.append(done, meta);
      const actions = document.createElement('div');
      actions.className = 'stia-actions stia-actions--fill';
      actions.append(
        button('重新生成', '', () => openChooser('regenerate', {
          originalId: shown.presetId || producer?.presetId || '',
        }), '↻'),
        button('查看 / 保存', 'stia-button--square', openOriginal, '⌕'),
        button('画廊', 'stia-button--square', () => onOpenGallery(tag.tagId), '▦'),
      );
      if (canAdjust) {
        actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
          prompt: actualPrompt,
          negativePrompt: actualNegativePrompt,
          provider: shown.provider || attempt?.provider || 'openai',
          result: shown,
          attempt,
        }), '✎'));
      }
      body.append(completion);
      const details = infoList(info);
      if (details) body.append(details);
      body.append(chooser?.mode === 'regenerate' ? rerollChooser(attempt) : actions);
      if (running.length) body.append(backgroundNote(running));
      body.append(promptDetails(actualPrompt));
      root.append(media, body);
      return;
    }

    const body = document.createElement('div');
    body.className = 'stia-card__body';
    if (attempt && ['failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      root.classList.add('stia-card--failed');
      body.append(statusHeading(
        '×',
        attempt.status === 'failed' ? '生成失败' : STATUS_TEXT[attempt.status],
        attempt.errorMessage || '请稍后重试',
        'is-danger',
      ));
      const actions = document.createElement('div');
      actions.className = 'stia-actions stia-actions--fill';
      actions.append(button('重试', 'stia-button--danger-soft', () => {
        onGenerate(tag, 'manual');
      }, '↻'));
      if (canUseBackup) {
        actions.append(button('换备用线路', '', () => {
          void Promise.resolve(onFallback(tag)).catch(() => {});
        }, '⇄'));
      }
      if (canAdjust) actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
        prompt: actualPrompt,
        negativePrompt: actualNegativePrompt,
        provider: attempt.provider || 'openai',
        attempt,
      }), '✎'));
      if (onRemove && !running.length) actions.append(removeButton());
      /* 四个按钮挤一行在手机上每个都要折成两行字，改成两个一行。 */
      if (actions.children.length >= 4) actions.classList.add('stia-actions--pairs');
      body.append(actions);
      if (running.length) body.append(backgroundNote(running));
      body.append(promptDetails(actualPrompt));
      root.append(body);
      return;
    }

    root.classList.add('stia-card--idle');
    body.append(statusHeading(
      '▧',
      '等待生成',
      `${attempt?.model || '使用当前预设模型'} · ${size || ratioLabel || '默认尺寸'}`,
      'is-accent',
    ));
    if (state.tag?.resultIds?.length) {
      const deleted = document.createElement('p');
      deleted.className = 'stia-muted';
      deleted.textContent = '上一张图片已删除，可以重新生成。';
      body.append(deleted);
    }
    const actions = document.createElement('div');
    actions.className = 'stia-actions stia-actions--fill';
    actions.append(button(attempt ? '重新生成' : '生成图片', 'stia-button--primary', () => {
      onGenerate(tag, 'manual');
    }, '▧'));
    if (onRemove && !running.length) actions.append(removeButton());
    if (canAdjust && attempt) actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
      prompt: actualPrompt,
      negativePrompt: actualNegativePrompt,
      provider: attempt.provider || 'openai',
      attempt,
    }), '✎'));
    body.append(promptDetails(actualPrompt), actions);
    if (running.length) body.append(backgroundNote(running));
    root.append(body);
  }

  return { root, render };
}
