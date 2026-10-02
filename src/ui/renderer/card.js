import { makeImageSaveable, openImageViewer } from '../media/image-viewer.js';

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

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
  if (seconds < 60) return `已用 ${seconds} 秒`;
  return `已用 ${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
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
  let cachedImage = null;
  let openCurrentImage = null;
  let timerNodes = [];
  let timing = null;
  /* 「再画一张」展开的选择：{ attemptId, presets }，presets 为 null 时正在读取。 */
  let chooser = null;

  /* 从这次生成开始时算起；同一次生成里状态怎么变都不重新计时。 */
  function elapsedSince(attempt) {
    if (!timing || timing.attemptId !== attempt.attemptId) {
      timing = { attemptId: attempt.attemptId, since: startedAt(attempt) };
    }
    return timing.since;
  }

  function timer(since) {
    const node = elapsedLabel(since);
    timerNodes.push(node);
    ensureElapsedTicker();
    return node;
  }

  /* 等不及时「再画一张」：GPT 有好几个 API 预设时先选用哪个（换 key、换分组），
     只有一个或用 NovelAI 时确认一下就画。正在画的那张留在后台接着画。 */
  function openChooser(attemptId) {
    chooser = { attemptId, presets: null };
    render();
    const wantsPresets = getSettings()?.generationProvider !== 'novelai' && typeof listPresets === 'function';
    Promise.resolve(wantsPresets ? listPresets() : [])
      .catch(() => [])
      .then(presets => {
        if (chooser?.attemptId !== attemptId) return;
        const list = Array.isArray(presets) ? presets : [];
        chooser = { attemptId, presets: [...list.filter(item => item.active), ...list.filter(item => !item.active)] };
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

  function rerollChooser(attempt) {
    const box = document.createElement('div');
    box.className = 'stia-card__reroll';
    const note = document.createElement('p');
    note.className = 'stia-muted';
    const actions = document.createElement('div');
    actions.className = 'stia-actions stia-actions--fill';
    const presets = chooser.presets;
    if (presets === null) {
      note.textContent = '正在读取 API 预设…';
    } else if (presets.length > 1) {
      note.textContent = '这张会在后台接着画。用哪个预设再画一张？';
      for (const preset of presets) {
        const label = `${preset.name}${preset.active ? '（当前）' : ''}${preset.hasApiKey === false ? '（没填 Key）' : ''}`;
        actions.append(button(label, 'stia-card__reroll-preset', () => startReroll(attempt, preset)));
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
    const actualPrompt = latest?.prompt
      || latest?.promptSnapshot
      || attempt?.promptSnapshot
      || attempt?.resolvedPrompt
      || tag.prompt;
    const actualNegativePrompt = latest?.negativePrompt
      || latest?.negativePromptSnapshot
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
    const src = latest ? api.fileUrl(latest.resultId) : '';
    const running = (state.attempts || []).slice(1).filter(item => ACTIVE_STATUSES.has(item.status));
    if (chooser && (chooser.attemptId !== attempt?.attemptId || !ACTIVE_STATUSES.has(attempt?.status))) {
      chooser = null;
    }
    const signature = JSON.stringify([
      attempt?.attemptId, attempt?.status, attempt?.requestMode, attempt?.statusMessage,
      attempt?.model, attempt?.provider, attempt?.errorMessage, size,
      latest?.resultId, latest?.provider, src, available.length,
      Boolean(state.tag?.resultIds?.length), actualPrompt, actualNegativePrompt, canAdjust, ratioLabel,
      running.map(item => item.attemptId), chooser && [chooser.attemptId, chooser.presets],
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
      if (canReroll && chooser) {
        body.append(rerollChooser(attempt));
      } else if (canReroll) {
        const actions = document.createElement('div');
        actions.className = 'stia-actions stia-actions--fill';
        actions.append(
          button('再画一张', '', () => openChooser(attempt.attemptId), '↻'),
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

    if (latest) {
      root.classList.add('stia-card--succeeded');
      const media = document.createElement('div');
      media.className = 'stia-card__media';
      let image = cachedImage?.src === src ? cachedImage.element : null;
      if (!image) {
        image = document.createElement('img');
        image.className = 'stia-card__image';
        image.src = src;
        image.loading = 'lazy';
        makeImageSaveable(image, () => openCurrentImage?.());
        cachedImage = { src, element: image };
      }
      image.alt = actualPrompt.slice(0, 120);
      const openOriginal = () => openImageViewer({
        src,
        alt: image.alt,
        filename: latest.resultId,
        prompt: actualPrompt,
        meta: [attempt?.model, size].filter(Boolean).join(' · '),
      });
      openCurrentImage = openOriginal;
      media.append(image);
      if (size) {
        const badge = document.createElement('span');
        badge.className = 'stia-card__size';
        badge.textContent = size;
        media.append(badge);
      }
      const body = document.createElement('div');
      body.className = 'stia-card__body';
      const completion = document.createElement('div');
      completion.className = 'stia-card__completion';
      const done = document.createElement('span');
      done.className = 'stia-success';
      done.textContent = '✓ 已完成';
      const history = document.createElement('span');
      history.className = 'stia-muted';
      history.textContent = `历史 ${available.length} 张`;
      completion.append(done, history);
      const actions = document.createElement('div');
      actions.className = 'stia-actions stia-actions--fill';
      actions.append(
        button('重新生成', '', () => onGenerate(tag, 'manual'), '↻'),
        button('查看 / 保存', 'stia-button--square', openOriginal, '⌕'),
        button('画廊', 'stia-button--square', () => onOpenGallery(tag.tagId), '▦'),
      );
      if (canAdjust) {
        actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
          prompt: actualPrompt,
          negativePrompt: actualNegativePrompt,
          provider: latest.provider || attempt?.provider || 'openai',
          result: latest,
          attempt,
        }), '✎'));
      }
      body.append(completion, actions);
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
      if (canAdjust) actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
        prompt: actualPrompt,
        negativePrompt: actualNegativePrompt,
        provider: attempt.provider || 'openai',
        attempt,
      }), '✎'));
      if (onRemove && !running.length) actions.append(removeButton());
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
