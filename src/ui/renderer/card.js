import { makeImageSaveable, openImageViewer } from '../media/image-viewer.js';
import { createCopyRow } from '../media/copy-text.js';
import { icon } from '../icons.js';
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

/* 出图后的用时：画出这张图的那一次从开始到存好一共多久。生成记录被清掉以后用图片记录里
   记的开始时间和存好时间；记录不全或时间对不上就不显示。 */
export function generationDuration(attempt, result = null) {
  let started = Date.parse(attempt?.createdAt || '');
  let finished = Date.parse(attempt?.completedAt || '');
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    started = Date.parse(result?.startedAt || '');
    finished = Date.parse(result?.createdAt || '');
  }
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

/* 按钮：图标（src/ui/icons.js 里的名字，可以不给）+ 文字。 */
function button(label, className, handler, iconName = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-button ${className || ''}`.trim();
  if (iconName) element.append(icon(iconName));
  const text = document.createElement('span');
  text.textContent = label;
  element.append(text);
  element.addEventListener('click', handler);
  return element;
}

/* 只有图标的圆按钮（翻页的左右箭头）：字写在 aria-label 里。 */
function iconButton(label, className, handler, iconName) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-icon-button ${className || ''}`.trim();
  element.setAttribute('aria-label', label);
  element.title = label;
  element.append(icon(iconName));
  element.addEventListener('click', handler);
  return element;
}

function promptDetails(prompt) {
  const details = document.createElement('details');
  details.className = 'stia-prompt';
  const summary = document.createElement('summary');
  const summaryText = document.createElement('span');
  summaryText.textContent = '查看提示词';
  summary.append(icon('chevron-right'), summaryText);
  const text = document.createElement('pre');
  text.textContent = prompt;
  /* 「一键复制」放在 details 里：展开前看不到，展开后在提示词下面。 */
  details.append(summary, text, createCopyRow(prompt));
  return details;
}

function displaySize(value) {
  return String(value || '').replace(/(\d)x(\d)/gi, '$1×$2');
}

/* 卡片下方这张图的信息：用的哪个预设、模型、画质、尺寸。以画出这张图的那一次为准，
   图片记录里有的先用图片记录；生成记录被清掉以后画质和尺寸也从图片记录拿（1.7.0 起记）；
   旧记录里没有的项不显示。智能重试去掉过的参数显示「默认」。 */
export function imageInfo(result, producer) {
  const novelai = (result?.provider || producer?.provider) === 'novelai';
  const dropped = new Set([
    ...(producer?.compatibilityRetry?.adjustedParameters || []),
    ...(result?.compatibilityRetry?.adjustedParameters || []),
  ]);
  const qualitySnapshot = typeof producer?.qualitySnapshot === 'string'
    ? producer.qualitySnapshot
    : (typeof result?.qualitySnapshot === 'string' ? result.qualitySnapshot : undefined);
  const requested = qualitySnapshot ?? producer?.parameters?.quality ?? '';
  let quality = '';
  if (!novelai) {
    if (dropped.has('quality')) quality = requested ? `默认（${requested} 被拒）` : '默认';
    else if (typeof qualitySnapshot === 'string') quality = qualitySnapshot || '默认';
    else quality = String(producer?.parameters?.quality || '');
  }
  const references = Array.isArray(result?.references)
    ? result.references.length
    : (Array.isArray(producer?.references) ? producer.references.length : 0);
  return {
    presetLabel: novelai ? '画师串' : '预设',
    preset: novelai
      ? (result?.artistPresetNameSnapshot || producer?.artistPresetNameSnapshot || '')
      : (result?.presetNameSnapshot || producer?.presetNameSnapshot || ''),
    model: result?.apiModel || producer?.model || '',
    quality,
    size: dropped.has('size') ? '默认尺寸' : displaySize(producer?.parameters?.size || result?.requestedSize || ''),
    references,
    /* 参考图组开着「高保真参考」，但这条线路不认 input_fidelity，这张是去掉它画的。 */
    fidelityRejected: references > 0 && dropped.has('input_fidelity'),
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
    ['参考图', info.references ? `带了 ${info.references} 张${info.fidelityRejected ? '（这条线路不认高保真）' : ''}` : '', 'is-wide'],
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

function statusHeading(iconName, title, subtitle, tone = '') {
  const heading = document.createElement('div');
  heading.className = `stia-card__status ${tone}`.trim();
  const badge = document.createElement('span');
  badge.className = 'stia-card__status-icon';
  badge.append(icon(iconName, { spin: iconName === 'spinner' }));
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
  heading.append(badge, copy);
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
  onReferenceRegenerate,
  listPresets,
  /* 「换预设」：getPresetChoices() 当拍给出 { kind: 'api' | 'artist', activeId, busy, items: [{ id, name }] }，
     onSwitchPreset(id) 把当前预设切过去。两个都给了、可选的不止一个才显示。 */
  getPresetChoices,
  onSwitchPreset,
}) {
  const root = document.createElement('section');
  root.className = 'stia-card';
  root.dataset.tagId = tag.tagId;
  root.setAttribute('aria-label', '画笺生图卡片');

  /* 一键删除：卡片、消息里的 <draw> 注入词、标签元数据一起清掉，不留痕迹。
     只在失败和待生成两种状态提供；已出图的走画廊删除，生成中的先取消。 */
  function removeButton() {
    return button('删除', 'stia-button--ghost stia-card__remove', () => onRemove(tag), 'trash');
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
  /* 「换预设」正在切换中。 */
  let switching = false;
  /* 没存进酒馆、直接从线路给的链接显示的图：按链接留着 <img>（重画卡片不重新加载），打不开的记一笔不再试。 */
  const remoteCache = new Map();

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
      /* 异步解码：几 MB 的 PNG 不在主线程上解，滑动时不卡。 */
      image.decoding = 'async';
      image.src = source;
      makeImageSaveable(image, () => openCurrentImage?.());
      imageCache.set(source, image);
    }
    return image;
  }

  /* 一张图的提示词、是哪次生成画的、下面那几项信息、尺寸。卡片上显示的那张和看图器里翻到的那张都用它。 */
  function describeResult(state, result) {
    const attempt = state.attempts?.[0];
    const producer = result
      ? (state.attempts || []).find(item => item.attemptId === result.attemptId)
      : null;
    const info = result ? imageInfo(result, producer) : null;
    const size = displaySize(attempt?.parameters?.size || '');
    return {
      prompt: result?.prompt
        || result?.promptSnapshot
        || attempt?.promptSnapshot
        || attempt?.resolvedPrompt
        || tag.prompt,
      producer,
      info,
      /* 「历史 N 张」旁边的尺寸跟着这张图；没有生成记录的老图片退回用最近那次的。 */
      imageSize: info ? (info.size === '默认尺寸' ? '' : info.size || size) : '',
    };
  }

  /* 原图查看器里这张图的内容。同一张卡有好几张图时可以在查看器里左右翻（按卡片上翻看的顺序）；
     关掉时卡片停在最后看的那张上。每次都按当时的记录现算。 */
  function originalOptions(resultId) {
    const state = getState(tag.tagId) || {};
    const available = (state.results || []).filter(result => result.status === 'available');
    const result = available.find(item => item.resultId === resultId);
    if (!result) return null;
    const { prompt, info, imageSize } = describeResult(state, result);
    const lookup = () => {
      const list = ((getState(tag.tagId) || {}).results || []).filter(item => item.status === 'available');
      return { list, index: list.findIndex(item => item.resultId === resultId) };
    };
    return {
      src: api.fileUrl(result.resultId),
      alt: String(prompt || '').slice(0, 120),
      filename: result.resultId,
      prompt,
      meta: [info.model, imageSize].filter(Boolean).join(' · '),
      position: () => {
        const { list, index } = lookup();
        return index < 0 ? null : { index, total: list.length };
      },
      neighbor: delta => {
        const { list, index } = lookup();
        const target = index < 0 ? null : list[index + delta];
        return target ? originalOptions(target.resultId) : null;
      },
      onClose: () => {
        if (!navigation || navigation.ids[navigation.index] === resultId || !navigation.ids.includes(resultId)) return;
        viewingId = resultId;
        preloadOthers = true;
        render();
      },
    };
  }

  /* 这次生成里线路给的图片链接（图画好了却没存进酒馆时记下的）。只认 http / https，最多 4 个。 */
  function remoteImagesOf(attempt) {
    if (attempt?.status !== 'failed' || !Array.isArray(attempt.remoteImages)) return [];
    return attempt.remoteImages
      .filter(value => typeof value === 'string' && /^https?:\/\//i.test(value))
      .slice(0, 4);
  }

  /* 从链接直接显示的那几张：<img> 不受浏览器「不许脚本跨站下载」的限制，下载不了的图照样显示得出来，
     长按就能存到相册。不带来源页地址（有的图床看到别的网站来要图会拒绝）。打不开就换成一句话。 */
  function remoteMedia(links, prompt, onBroken) {
    const media = document.createElement('div');
    media.className = 'stia-card__media stia-card__media--remote';
    for (const key of remoteCache.keys()) {
      if (!links.includes(key)) remoteCache.delete(key);
    }
    for (const link of links) {
      let entry = remoteCache.get(link);
      if (!entry) {
        const image = document.createElement('img');
        image.className = 'stia-card__image';
        image.referrerPolicy = 'no-referrer';
        image.setAttribute('referrerpolicy', 'no-referrer');
        image.decoding = 'async';
        image.alt = String(prompt || '').slice(0, 120);
        image.src = link;
        makeImageSaveable(image, () => openImageViewer({
          src: link,
          alt: image.alt,
          prompt,
          meta: '线路给的临时链接，没存进酒馆 · 长按图片存到相册',
          remote: true,
        }));
        entry = { image, broken: false };
        const current = entry;
        image.addEventListener('error', () => {
          current.broken = true;
          if (image.isConnected) image.replaceWith(brokenNote());
          current.onBroken?.();
        }, { once: true });
        remoteCache.set(link, entry);
      }
      /* 图片元素是留着重用的，卡片重画后说明那行字是新的：每次都换成这一次的回调。 */
      entry.onBroken = onBroken;
      media.append(entry.broken ? brokenNote() : entry.image);
    }
    return media;
  }

  function brokenNote() {
    const note = document.createElement('p');
    note.className = 'stia-card__remote-broken';
    note.textContent = '这个链接现在打不开：可能已经过期，或者这台设备连不上放图的那台主机。可以点下面的键在新标签页里再试一次。';
    return note;
  }

  /* 到头了就停，不绕回去：那边的按钮是灰的。 */
  function step(delta) {
    const target = navigation ? navigation.index + delta : -1;
    if (target < 0 || target >= navigation.ids.length) return;
    viewingId = navigation.ids[target];
    preloadOthers = true;
    render();
  }

  /* 同一张卡有好几张图时，分隔线下面的「‹上一张　2 / 4　›下一张」。图片上什么都不压。 */
  function pager(index, total) {
    const row = document.createElement('div');
    row.className = 'stia-card__pager';
    const previous = iconButton('上一张', 'stia-card__nav is-prev', () => step(-1), 'chevron-left');
    previous.disabled = index <= 0;
    const count = document.createElement('span');
    count.className = 'stia-card__pager-count';
    count.textContent = `${index + 1} / ${total}`;
    const next = iconButton('下一张', 'stia-card__nav is-next', () => step(1), 'chevron-right');
    next.disabled = index >= total - 1;
    row.append(previous, count, next);
    return row;
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
  /* mode 'reference'：「参考重画」，先选用哪张图当参考（默认卡片上这张，可从相册另选），再选预设。 */
  function openChooser(mode, { attemptId = null, originalId = '', reference = null } = {}) {
    chooser = { mode, attemptId, originalId, presets: null, reference, uploading: false, error: '' };
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
          if ((mode === 'regenerate' || mode === 'reference') && item.id === originalId) return 0;
          return item.active ? 1 : item.backup ? 2 : 3;
        };
        chooser = { ...chooser, presets: [...list].sort((left, right) => rank(left) - rank(right)) };
        render();
      });
  }

  function startReferenceRegenerate(preset) {
    const reference = chooser?.reference;
    chooser = null;
    render();
    if (!reference) return;
    void Promise.resolve(onReferenceRegenerate(tag, { references: [reference], preset })).catch(() => {});
  }

  /* 从相册另选一张当参考：先存进酒馆拿到路径，用完由直连那边删掉。 */
  function pickReferenceFile() {
    if (!chooser || typeof api?.uploadReferenceImage !== 'function') return;
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/webp';
    picker.hidden = true;
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      picker.remove?.();
      if (!file || !chooser) return;
      chooser = { ...chooser, uploading: true, error: '' };
      render();
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const uploaded = await api.uploadReferenceImage({ bytes, filename: file.name });
        if (!chooser) return;
        chooser = { ...chooser, uploading: false, reference: { path: uploaded.path, temporary: true, name: file.name } };
      } catch (error) {
        if (!chooser) return;
        chooser = { ...chooser, uploading: false, error: error?.message || '参考图上传失败' };
      }
      render();
    });
    document.body?.append?.(picker);
    picker.click?.();
  }

  function referenceChooser() {
    const box = document.createElement('div');
    box.className = 'stia-card__reroll';
    const note = document.createElement('p');
    note.className = 'stia-muted';
    const reference = chooser.reference;
    note.textContent = reference?.temporary
      ? `用相册里选的「${reference.name || '这张图'}」当参考重画，人脸、服装跟着它。`
      : '用卡片上这张图当参考重画，人脸、服装跟着它。';
    box.append(note);
    const source = document.createElement('div');
    source.className = 'stia-actions stia-actions--fill';
    source.append(button(chooser.uploading ? '正在上传…' : '从相册另选一张', 'stia-button--ghost stia-card__reference-pick', pickReferenceFile, 'image'));
    box.append(source);
    if (chooser.error) {
      const error = document.createElement('p');
      error.className = 'stia-status stia-error';
      error.textContent = chooser.error;
      box.append(error);
    }
    const actions = document.createElement('div');
    actions.className = 'stia-actions stia-actions--fill';
    const presets = chooser.presets;
    if (presets === null) {
      const loading = document.createElement('p');
      loading.className = 'stia-muted';
      loading.textContent = '正在读取 API 预设…';
      box.append(loading);
    } else if (presets.length > 1) {
      for (const preset of presets) {
        actions.append(button(presetLabel(preset), 'stia-card__reroll-preset', () => startReferenceRegenerate(preset)));
      }
    } else {
      actions.append(button('确定参考重画', 'stia-button--primary', () => startReferenceRegenerate(presets[0]), 'portrait'));
    }
    actions.append(button('算了', 'stia-button--ghost stia-card__reroll-close', closeChooser));
    box.append(actions);
    return box;
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
    const original = (chooser.mode === 'regenerate' || chooser.mode === 'reference') && preset.id === chooser.originalId;
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
      actions.append(button('确定再画一张', 'stia-button--primary', () => startReroll(attempt, presets[0]), 'refresh'));
    }
    actions.append(button('算了', 'stia-button--ghost stia-card__reroll-close', closeChooser));
    box.append(note, actions);
    return box;
  }

  /* 出图后、失败后那排按钮里的「换预设」：当前的生图预设（NovelAI 时是当前画师串），不用进设置页就能换。
     画成按钮的样子，上面盖一个透明的系统选择框：点哪儿都是打开系统自己的选择器，手机上最顺手。
     换的是全局的当前预设，之后新出的图都用它；这张图是哪个预设画的看上面的信息栏。
     只换预设，不替人点「重试」：重试要花钱，得自己点。 */
  function presetSwitch(choices) {
    const artist = choices.kind === 'artist';
    const current = choices.items.find(item => item.id === choices.activeId);
    const busy = switching || choices.busy === true;
    const control = document.createElement('label');
    control.className = `stia-button stia-card__preset${busy ? ' is-busy' : ''}`;
    /* 和设置页「API 配置」一个图标；「换备用线路」用的是来回箭头，两个挨着不能长一样。 */
    const glyph = icon('sliders');
    const name = document.createElement('span');
    name.className = 'stia-card__preset-name';
    name.textContent = switching ? '正在切换…' : `${artist ? '画师串' : '预设'}：${current?.name || '未选择'}`;
    const select = document.createElement('select');
    select.className = 'stia-card__preset-select';
    select.setAttribute('aria-label', artist ? '切换当前画师串预设' : '切换当前生图预设');
    select.disabled = busy;
    for (const item of choices.items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.append(option);
    }
    select.value = choices.activeId;
    select.addEventListener('change', () => {
      const nextId = select.value;
      if (!nextId || nextId === choices.activeId) return;
      switching = true;
      render();
      /* 切成没切成都重画一遍：没切成时选择框回到原来那个。 */
      Promise.resolve()
        .then(() => onSwitchPreset(nextId))
        .catch(() => false)
        .then(() => {
          switching = false;
          render();
        });
    });
    control.append(glyph, name, select);
    return control;
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
    const described = describeResult(state, shown);
    const actualPrompt = described.prompt;
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
    const { producer, info, imageSize } = described;
    const duration = shown ? generationDuration(producer, shown) : '';
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
    /* 参考重画只有免服务端直连的 GPT 有：拿这张图当参考走图生图接口。 */
    const canReference = typeof onReferenceRegenerate === 'function'
      && Boolean(shown)
      && settings.executionMode !== 'server'
      && settings.generationProvider !== 'novelai'
      && (shown?.provider || attempt?.provider || 'openai') !== 'novelai';
    /* 「换预设」：出了图的卡片和失败（含被中断、已取消）的卡片上有；可选的不止一个才有意义。 */
    const failed = !shown && ['failed', 'interrupted', 'cancelled'].includes(attempt?.status);
    const choices = (shown || failed) && typeof getPresetChoices === 'function' && typeof onSwitchPreset === 'function'
      ? getPresetChoices()
      : null;
    const canSwitch = Array.isArray(choices?.items) && choices.items.length > 1;
    /* 卡片换了状态（开始画了、画完了），对应的选择就收起。 */
    const chooserStale = chooser?.mode === 'regenerate' || chooser?.mode === 'reference'
      ? (!shown || ACTIVE_STATUSES.has(attempt?.status))
      : chooser && (chooser.attemptId !== attempt?.attemptId || !ACTIVE_STATUSES.has(attempt?.status));
    if (chooserStale) chooser = null;
    const signature = JSON.stringify([
      attempt?.attemptId, attempt?.status, attempt?.requestMode, attempt?.statusMessage,
      attempt?.model, attempt?.provider, attempt?.errorMessage, attempt?.remoteImages, size,
      shown?.resultId, shown?.provider, src, available.map(result => result.resultId), shownIndex,
      Boolean(state.tag?.resultIds?.length), actualPrompt, actualNegativePrompt, canAdjust, ratioLabel,
      running.map(item => item.attemptId),
      chooser && [chooser.mode, chooser.attemptId, chooser.presets, chooser.reference?.path || chooser.reference?.resultId, chooser.uploading, chooser.error],
      duration, info, imageSize, canUseBackup, canReference,
      canSwitch && [choices.kind, choices.activeId, choices.busy === true, choices.items, switching],
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
        isAutoQueue ? 'clock' : 'spinner',
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
          button('再画一张', '', () => openChooser('reroll', { attemptId: attempt.attemptId }), 'refresh'),
          button('取消', 'stia-button--ghost', () => onCancel(attempt.attemptId), 'close'),
        );
        body.append(actions);
      } else {
        body.append(button(
          isAutoQueue ? '取消排队' : '取消',
          'stia-button--ghost stia-button--full',
          () => onCancel(attempt.attemptId),
          'close',
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
      const openOriginal = () => {
        const options = originalOptions(shown.resultId);
        if (options) openImageViewer(options);
      };
      openCurrentImage = openOriginal;
      /* 图片上不压任何东西：用时在「已完成」旁边，尺寸在「历史 N 张」旁边，翻看在分隔线下面。 */
      media.append(image);
      navigation = { ids: available.map(result => result.resultId), index: shownIndex };
      const body = document.createElement('div');
      body.className = 'stia-card__body';
      const completion = document.createElement('div');
      completion.className = 'stia-card__completion';
      const status = document.createElement('span');
      status.className = 'stia-card__completion-status';
      const done = document.createElement('span');
      done.className = 'stia-success stia-card__done';
      const doneText = document.createElement('span');
      doneText.textContent = '已完成';
      done.append(icon('check'), doneText);
      status.append(done);
      if (duration) {
        const spent = document.createElement('span');
        spent.className = 'stia-card__duration';
        spent.textContent = duration;
        status.append(spent);
      }
      const meta = document.createElement('span');
      meta.className = 'stia-card__completion-meta';
      const history = document.createElement('span');
      history.className = 'stia-muted';
      history.textContent = `历史 ${available.length} 张`;
      meta.append(history);
      const sizeText = info.size || imageSize;
      if (sizeText) {
        const sizeNote = document.createElement('span');
        sizeNote.className = 'stia-card__completion-size';
        sizeNote.textContent = sizeText;
        meta.append(sizeNote);
      }
      completion.append(status, meta);
      const actions = document.createElement('div');
      actions.className = 'stia-actions stia-actions--fill';
      /* 第一行三个：重新生成宽一点，原图、画廊各占一份；字都在一行里，三个一样高。
         「原图」打开看图器：放大看、长按保存、分享都在那里（点图片本身也一样）。 */
      const original = button('原图', 'stia-card__action-side', openOriginal, 'expand');
      original.setAttribute('aria-label', '查看原图、保存');
      original.title = '查看原图、保存';
      actions.append(
        button('重新生成', 'stia-card__action-main', () => openChooser('regenerate', {
          originalId: shown.presetId || producer?.presetId || '',
        }), 'refresh'),
        original,
        button('画廊', 'stia-card__action-side', () => onOpenGallery(tag.tagId), 'grid'),
      );
      if (canReference) {
        actions.append(button('参考重画', '', () => openChooser('reference', {
          originalId: shown.presetId || producer?.presetId || '',
          reference: { resultId: shown.resultId },
        }), 'portrait'));
      }
      /* 和「参考重画」各占一半；没有「参考重画」时自己一行。 */
      if (canSwitch) actions.append(presetSwitch(choices));
      if (canAdjust) {
        actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
          prompt: actualPrompt,
          negativePrompt: actualNegativePrompt,
          provider: shown.provider || attempt?.provider || 'openai',
          result: shown,
          attempt,
        }), 'pencil'));
      }
      /* 第一行那三个之后的，两个一行。 */
      actions.classList.add('stia-actions--result');
      if (actions.children.length >= 4) actions.classList.add('stia-actions--pairs');
      body.append(completion);
      const details = infoList(info);
      if (details) body.append(details);
      const choosing = chooser?.mode === 'regenerate' || chooser?.mode === 'reference';
      /* 选预设重新生成时先收起翻看：「原渠道」是按打开时看的那张标的。 */
      if (available.length > 1 && !choosing) body.append(pager(shownIndex, available.length));
      body.append(choosing ? (chooser.mode === 'reference' ? referenceChooser() : rerollChooser(attempt)) : actions);
      if (running.length) body.append(backgroundNote(running));
      body.append(promptDetails(actualPrompt));
      root.append(media, body);
      return;
    }

    const body = document.createElement('div');
    body.className = 'stia-card__body';
    if (attempt && ['failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      root.classList.add('stia-card--failed');
      /* 图画好了却没存进酒馆（线路只给了链接、下载不了）：钱已经花了，图直接从链接显示出来，能长按存走。 */
      const remote = remoteImagesOf(attempt);
      const actions = document.createElement('div');
      actions.className = 'stia-actions stia-actions--fill';
      if (remote.length) {
        root.classList.add('stia-card--salvaged');
        const heading = statusHeading('alert', '图画好了，没能存进酒馆', ' ', 'is-warning');
        const subtitle = heading.querySelector('small');
        /* 图加载不出来是过后才知道的（链接过期了、这台设备连不上那台主机）：说明跟着改，别还写着「上面这张」。 */
        const describe = () => {
          subtitle.textContent = remote.every(link => remoteCache.get(link)?.broken)
            ? '线路给了图片链接，但现在打不开，图显示不出来。可以点下面的键在新标签页里再试一次。再画一张会再扣一次钱。'
            : '上面这张是直接从线路给的链接显示的。长按图片可以存到相册；链接过一阵会失效，想留就现在存。再画一张会再扣一次钱。';
        };
        root.append(remoteMedia(remote, actualPrompt, describe));
        describe();
        body.append(heading);
        const why = document.createElement('details');
        why.className = 'stia-card__salvage-reason';
        const summary = document.createElement('summary');
        summary.textContent = '为什么没存进酒馆';
        const text = document.createElement('p');
        text.textContent = attempt.errorMessage || '下载不了线路给的图片';
        why.append(summary, text);
        body.append(why);
        remote.forEach((link, index) => {
          const open = document.createElement('a');
          open.className = 'stia-button';
          open.href = link;
          open.target = '_blank';
          open.rel = 'noopener noreferrer';
          open.referrerPolicy = 'no-referrer';
          const label = document.createElement('span');
          label.textContent = remote.length > 1 ? `打开第 ${index + 1} 张` : '打开图片链接';
          open.append(icon('expand'), label);
          actions.append(open);
        });
      } else {
        body.append(statusHeading(
          attempt.status === 'cancelled' ? 'close' : 'alert',
          attempt.status === 'failed' ? '生成失败' : STATUS_TEXT[attempt.status],
          attempt.errorMessage || '请稍后重试',
          'is-danger',
        ));
      }
      actions.append(button(remote.length ? '重新画一张' : '重试', remote.length ? '' : 'stia-button--danger-soft', () => {
        void Promise.resolve(onGenerate(tag, 'manual')).catch(() => {});
      }, 'refresh'));
      if (canUseBackup) {
        actions.append(button('换备用线路', '', () => {
          void Promise.resolve(onFallback(tag)).catch(() => {});
        }, 'swap'));
      }
      /* 这条线路不行就在这儿换一个，再点「重试」：重试用的是当前预设。 */
      if (canSwitch) actions.append(presetSwitch(choices));
      if (canAdjust) actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
        prompt: actualPrompt,
        negativePrompt: actualNegativePrompt,
        provider: attempt.provider || 'openai',
        attempt,
      }), 'pencil'));
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
      'image',
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
      /* 失败由报错弹窗和卡片状态说明，这里接住 reject，不留未处理的异常。 */
      void Promise.resolve(onGenerate(tag, 'manual')).catch(() => {});
    }, 'sparkles'));
    if (onRemove && !running.length) actions.append(removeButton());
    if (canAdjust && attempt) actions.append(button('调整后重绘', '', () => onAdjustRegenerate(tag, {
      prompt: actualPrompt,
      negativePrompt: actualNegativePrompt,
      provider: attempt.provider || 'openai',
      attempt,
    }), 'pencil'));
    body.append(promptDetails(actualPrompt), actions);
    if (running.length) body.append(backgroundNote(running));
    root.append(body);
  }

  return { root, render };
}
