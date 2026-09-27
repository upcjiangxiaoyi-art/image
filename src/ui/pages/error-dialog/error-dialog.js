import { MODERATION_PATTERN } from '../../api/openai-direct.js';

/* 报错弹窗：生图失败、连不上、超时、被审核拦截等报错都弹；「生成失败后智能重试」去掉
   quality / size / n 才出图时也弹，免得把回退后的图当成按 max 出的。设置页、画廊等处的
   报错也走这里，卡片和设置页上原有的报错提示照旧保留。点一下弹窗任意位置就关；弹窗开着时
   再来的报错合并进来，内容相同只累计次数。 */

export const PREMIUM_QUALITIES = Object.freeze(['xhigh', 'max']);

/* response_format 只影响图片怎么传回来，不改变图片本身，回退了也不打扰。 */
const OUTPUT_PARAMETERS = Object.freeze({
  quality: '质量 quality',
  size: '尺寸 size',
  n: '数量 n',
});

const NETWORK_CODES = new Set(['DIRECT_FETCH_BLOCKED', 'SERVER_PLUGIN_UNAVAILABLE']);
const SETUP_CODES = new Set(['PRESET_NOT_CONFIGURED', 'API_KEY_MISSING', 'MODEL_NOT_SELECTED']);
const TIMEOUT_STATUSES = new Set([408, 504, 524]);
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
  if (Number.isInteger(error?.status) && error.status > 0 && error.code === 'UPSTREAM_HTTP_ERROR') {
    return error.status;
  }
  const match = /HTTP (\d{3})/.exec(String(attempt?.errorMessage || error?.message || ''));
  return match ? Number(match[1]) : 0;
}

function withDetails(message, details) {
  const text = String(message || '').trim();
  const extra = typeof details === 'string' ? details.trim() : '';
  return extra && !text.includes(extra) ? `${text}（${extra}）` : text;
}

/* 标题直接说是哪一类报错，小弹窗扫一眼就知道卡在哪。 */
function problemTitle({ code, httpStatus, text, fallback }) {
  if (MODERATION_PATTERN.test(text)) return '内容被审核拦截';
  if (code === 'UPSTREAM_TIMEOUT' || TIMEOUT_STATUSES.has(httpStatus)) return '请求超时';
  if (NETWORK_CODES.has(code)) return /下载/.test(text) ? '图片下载失败' : '连不上服务器';
  if (code === 'UPSTREAM_AUTH_FAILED') return '密钥或权限有问题';
  if (code === 'UPSTREAM_RATE_LIMITED') return '请求太频繁，被限流了';
  if (SETUP_CODES.has(code)) return '接口还没配置好';
  if (code === 'IMAGE_DOWNLOAD_FAILED') return '图片下载失败';
  if (code === 'LOCAL_SAVE_FAILED') return '保存到酒馆失败';
  if (httpStatus >= 500) return '上游服务器出错';
  return fallback;
}

function premiumQualityNote(quality) {
  return `本次请求的 quality 是 ${quality}：xhigh / max 只有 gpt-image-2.5-flare / gpt-image-2.5-sunburst 支持，`
    + '其他模型最高是 high；走中转站时以中转站为准。';
}

export function describeGenerationProblem({ attempt, error, quality = '' } = {}) {
  const status = attempt?.status || (error ? 'failed' : '');
  if (status === 'failed' || status === 'interrupted') {
    const interrupted = status === 'interrupted';
    const message = withDetails(
      attempt?.errorMessage || error?.message || (interrupted ? '生成被中断' : '生成失败'),
      error?.details,
    );
    const code = attempt?.errorCode || error?.code || '';
    const httpStatus = httpStatusOf(attempt, error);
    const title = interrupted
      ? '生成被中断'
      : problemTitle({ code, httpStatus, text: message, fallback: '生成失败' });
    const parameterRejected = code === 'UPSTREAM_HTTP_ERROR'
      && [400, 422].includes(httpStatus)
      && title === '生成失败';
    return {
      tone: 'danger',
      title,
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

/* 生图以外的报错（设置页、画廊、连接服务、取消、删除等）。 */
export function describeError(error, fallbackTitle = '操作失败') {
  if (!error) return null;
  const message = withDetails(error.message || String(error), error.details);
  if (!message) return null;
  return {
    tone: 'danger',
    title: problemTitle({
      code: error.code || '',
      httpStatus: httpStatusOf(null, error),
      text: message,
      fallback: fallbackTitle,
    }),
    message,
    hint: '',
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
  panel.tabIndex = -1;
  const heading = document.createElement('h3');
  heading.className = 'stia-error-dialog__title';
  const icon = document.createElement('span');
  icon.className = 'stia-error-dialog__icon';
  icon.setAttribute('aria-hidden', 'true');
  const headingText = document.createElement('span');
  heading.append(icon, headingText);
  const list = document.createElement('div');
  list.className = 'stia-error-dialog__list';
  const dismissHint = paragraph('stia-error-dialog__dismiss', '点一下关闭');
  panel.append(heading, list, dismissHint);
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
      : `画笺 · ${entries.length} 条报错`;
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
    panel.focus({ preventScroll: true });
  }

  /* 点弹窗任意位置或空白处都关；在弹窗里拖选文字（想复制报错）时不关。 */
  overlay.addEventListener('click', () => {
    const selection = document.getSelection?.();
    if (selection && !selection.isCollapsed && panel.contains(selection.anchorNode)) return;
    close();
  });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    close();
  });
  /* 捕获阶段拦下 Escape：只关弹窗，不连带关掉下面的设置窗口。 */
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || overlay.hidden) return;
    event.stopPropagation();
    close();
  }, true);

  return { show, close, root: overlay };
}
