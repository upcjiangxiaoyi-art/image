/* 报错弹窗：生图失败时弹出；「生成失败后智能重试」去掉 quality / size / n 才出图时也弹，
   免得把回退后的图当成按 max 出的。卡片上的失败提示照旧保留。弹窗开着时再来的提醒追加到
   同一个弹窗里，内容相同只累计次数。 */

export const PREMIUM_QUALITIES = Object.freeze(['xhigh', 'max']);

/* response_format 只影响图片怎么传回来，不改变图片本身，回退了也不打扰。 */
const OUTPUT_PARAMETERS = Object.freeze({
  quality: '质量 quality',
  size: '尺寸 size',
  n: '数量 n',
});

const MAX_ENTRIES = 10;

/* 与 openai-direct 组请求体的顺序一致：标签 quality → 默认质量（选「不发送」则不发）→
   「额外请求参数 JSON」里的 quality 最后覆盖。 */
export function requestedQuality({ provider = 'openai', preset, tagQuality } = {}) {
  if (provider === 'novelai' || !preset) return '';
  const extra = preset.extraBody?.quality;
  if (typeof extra === 'string' && extra.trim()) return extra.trim();
  if (preset.sendQuality === false) return '';
  return String(tagQuality || preset.defaultQuality || '').trim();
}

function isPremiumQuality(quality) {
  return PREMIUM_QUALITIES.includes(String(quality || '').toLowerCase());
}

function httpStatusOf(attempt, error) {
  if (Number.isInteger(error?.status) && error.status > 0) return error.status;
  const match = /HTTP (\d{3})/.exec(String(attempt?.errorMessage || error?.message || ''));
  return match ? Number(match[1]) : 0;
}

function premiumQualityNote(quality) {
  return `本次请求的 quality 是 ${quality}：xhigh / max 只有 gpt-image-2.5-flare / gpt-image-2.5-sunburst 支持，`
    + '其他模型最高是 high；走中转站时以中转站为准。';
}

export function describeGenerationProblem({ attempt, error, quality = '' } = {}) {
  const status = attempt?.status || (error ? 'failed' : '');
  if (status === 'failed') {
    let message = String(attempt?.errorMessage || error?.message || '生成失败');
    const details = typeof error?.details === 'string' ? error.details.trim() : '';
    if (details && !message.includes(details)) message += `（${details}）`;
    const code = attempt?.errorCode || error?.code || '';
    const parameterRejected = code === 'UPSTREAM_HTTP_ERROR'
      && [400, 422].includes(httpStatusOf(attempt, error));
    return {
      tone: 'danger',
      title: '生成失败',
      message,
      hint: parameterRejected && isPremiumQuality(quality)
        ? `${premiumQualityNote(quality)}如果报错说的是 quality，请换用这两个模型，或把默认质量改回 high。`
        : '',
    };
  }
  if (status !== 'succeeded') return null;
  const dropped = (attempt?.compatibilityRetry?.adjustedParameters || [])
    .filter(name => Object.hasOwn(OUTPUT_PARAMETERS, name));
  if (!dropped.length) return null;
  const qualityDropped = dropped.includes('quality') && Boolean(quality);
  return {
    tone: 'warning',
    title: '参数被上游拒绝，已自动回退',
    message: `上游不接受本次请求的${dropped.map(name => OUTPUT_PARAMETERS[name]).join('、')}，`
      + '「生成失败后智能重试」去掉后重新生成成功。这张图按上游默认值生成'
      + `${qualityDropped ? `，不是 quality=${quality}` : ''}。`,
    hint: qualityDropped && isPremiumQuality(quality) ? premiumQualityNote(quality) : '',
  };
}

function paragraph(className, text) {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

export function createErrorDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'stia-error-dialog';
  overlay.hidden = true;
  const panel = document.createElement('section');
  panel.className = 'stia-error-dialog__panel';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');
  const heading = document.createElement('h3');
  heading.className = 'stia-error-dialog__title';
  const icon = document.createElement('span');
  icon.className = 'stia-error-dialog__icon';
  icon.setAttribute('aria-hidden', 'true');
  const headingText = document.createElement('span');
  heading.append(icon, headingText);
  const list = document.createElement('div');
  list.className = 'stia-error-dialog__list';
  const buttons = document.createElement('div');
  buttons.className = 'stia-actions stia-actions--fill';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'stia-button stia-button--primary';
  dismiss.textContent = '知道了';
  buttons.append(dismiss);
  panel.append(heading, list, buttons);
  overlay.append(panel);
  document.body.append(overlay);

  let entries = [];
  let returnFocus = null;

  function render() {
    const tone = entries.some(entry => entry.tone === 'danger') ? 'danger' : 'warning';
    panel.dataset.tone = tone;
    icon.textContent = tone === 'danger' ? '×' : '!';
    headingText.textContent = entries.length === 1
      ? entries[0].title
      : `画笺 · ${entries.length} 条生图提醒`;
    panel.setAttribute('aria-label', headingText.textContent);
    list.replaceChildren(...entries.map(entry => {
      const item = document.createElement('article');
      item.className = `stia-error-dialog__item is-${entry.tone}`;
      if (entries.length > 1 || entry.count > 1) {
        const title = document.createElement('strong');
        title.textContent = entry.count > 1 ? `${entry.title}（×${entry.count}）` : entry.title;
        item.append(title);
      }
      item.append(paragraph('stia-error-dialog__message', entry.message));
      if (entry.hint) item.append(paragraph('stia-error-dialog__hint', entry.hint));
      return item;
    }));
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    entries = [];
    list.replaceChildren();
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function show(problem) {
    if (!problem?.message) return;
    const key = `${problem.title}\n${problem.message}`;
    const existing = entries.find(entry => entry.key === key);
    if (existing) existing.count += 1;
    else entries = [...entries, { ...problem, key, count: 1 }].slice(-MAX_ENTRIES);
    render();
    if (!overlay.hidden) return;
    returnFocus = document.activeElement;
    overlay.hidden = false;
    dismiss.focus({ preventScroll: true });
  }

  dismiss.addEventListener('click', close);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
  });
  /* 捕获阶段拦下 Escape：只关弹窗，不连带关掉下面的设置窗口。 */
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || overlay.hidden) return;
    event.stopPropagation();
    close();
  }, true);

  return { show, close, root: overlay };
}
