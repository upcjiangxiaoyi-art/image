import { MODERATION_PATTERN } from '../../api/openai-direct.js';

/* 报错弹窗：生图失败、连不上、超时、被审核拦截等报错都弹；「生成失败后智能重试」去掉
   quality / size / n 才出图时也弹，免得把回退后的图当成按 max 出的。设置页、画廊等处的
   报错也走这里，卡片和设置页上原有的报错提示照旧保留。点一下弹窗任意位置就关；弹窗开着时
   再来的报错合并进来，内容相同只累计次数。生图失败的那条带「重新生成」键，不用再滑到卡片上点。
   重 roll、滑走或切走聊天时还在画的图，画好后也在这里提醒一声，带「查看」键。 */

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
const TONE_ICONS = Object.freeze({ danger: '×', warning: '!', info: '✓' });

/* 出结果时卡片已经不在眼前（placement 的含义见 generation-controller）。 */
const MOVED_RESULT = Object.freeze({
  swipe: {
    title: '上一版回复的图画好了',
    message: '已经放回那一版回复里，滑回去就能看到；画廊里也有。',
    failure: '这是上一版回复里的图，滑回那一版可以在卡片上重试。',
  },
  gone: {
    title: '上一版回复的图画好了',
    message: '原来那张卡片已经不在了（回复被重新生成、删除或改动过），图存进了画廊。',
    failure: '这是上一版回复里的图，原来那张卡片已经不在了。',
  },
  elsewhere: {
    title: '另一个聊天里的图画好了',
    message: '回到那个聊天就能看到；画廊里也有。',
    failure: '这是另一个聊天里的图，回到那个聊天可以在卡片上重试。',
  },
});

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

function joinLines(...lines) {
  return lines.filter(Boolean).join('\n');
}

export function describeGenerationProblem({ attempt, error, quality = '', placement = 'active' } = {}) {
  /* 消息被重 roll、滑走、改动或删除后，排着的旧标签已经没有意义，不打扰。 */
  if ((attempt?.errorCode || error?.code) === 'TAG_NOT_FOUND') return null;
  const moved = Object.hasOwn(MOVED_RESULT, placement) ? MOVED_RESULT[placement] : null;
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
      hint: joinLines(
        moved?.failure,
        parameterRejected && isPremiumQuality(quality)
          ? `${premiumQualityNote(quality)}如果报错说的是 quality，请换用这两个模型，或把默认质量改回 high。`
          : '',
      ),
    };
  }
  if (status !== 'succeeded') return null;
  const dropped = (attempt?.compatibilityRetry?.adjustedParameters || [])
    .filter(name => Object.hasOwn(OUTPUT_PARAMETERS, name));
  const qualityDropped = dropped.includes('quality') && Boolean(quality);
  const fallbackMessage = dropped.length
    ? `上游不接受本次请求的${dropped.map(name => OUTPUT_PARAMETERS[name]).join('、')}，`
      + '「生成失败后智能重试」去掉后重新生成成功。这张图按上游默认值生成'
      + `${qualityDropped ? `，不是 quality=${quality}` : ''}。`
    : '';
  const fallbackHint = qualityDropped && isPremiumQuality(quality) ? premiumQualityNote(quality) : '';
  /* 卡片已经不在眼前：告诉用户图去了哪，带上 resultId 好「查看」。 */
  if (moved) {
    return {
      tone: 'info',
      title: moved.title,
      message: moved.message,
      hint: joinLines(fallbackMessage, fallbackHint),
      resultId: attempt?.resultIds?.at(-1) || '',
    };
  }
  if (!dropped.length) return null;
  return {
    tone: 'warning',
    title: '参数被上游拒绝，已自动回退',
    message: fallbackMessage,
    hint: fallbackHint,
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

/* 报错弹窗开不开、生图失败那条带不带「重新生成」键、画好的图带不带「查看」键，都在这里决定。
   弹窗要等酒馆页面就绪后才创建，所以用 getDialog 按需取；viewResult(resultId, attempt) 打开原图。 */
export function createProblemReporter({ store, getDialog, viewResult }) {
  function show(describe) {
    if (store.state.settings.enableErrorPopup === false) return;
    try {
      const problem = describe();
      if (problem) getDialog()?.show(problem);
    } catch (error) {
      console.warn('[画笺] 无法显示报错弹窗', error);
    }
  }

  return {
    reportProblem(context, retry) {
      show(() => {
        const problem = describeGenerationProblem(context);
        if (problem?.tone === 'danger' && retry) return { ...problem, retry };
        if (problem?.resultId && typeof viewResult === 'function') {
          return { ...problem, view: () => viewResult(problem.resultId, context.attempt) };
        }
        return problem;
      });
    },
    reportError(error, title) {
      show(() => describeError(error, title));
    },
  };
}

function block(className, text = '') {
  const element = document.createElement('div');
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

/* 用原生 <dialog> + showModal() 放进浏览器顶层（top layer）：主题或角色卡 CSS 给 body 加的
   transform / 滤镜、各种 z-index 装饰都挪不动也盖不住它，永远相对屏幕居中；背景变暗交给
   ::backdrop，点背景也一定点得到。浏览器不支持 showModal 时退回普通的固定定位。 */
export function createErrorDialog() {
  const root = document.createElement('dialog');
  root.className = 'stia-error-dialog';
  root.hidden = true;
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  root.tabIndex = -1;
  const heading = block('stia-error-dialog__title');
  const icon = document.createElement('span');
  icon.className = 'stia-error-dialog__icon';
  icon.setAttribute('aria-hidden', 'true');
  const headingText = document.createElement('span');
  headingText.className = 'stia-error-dialog__heading';
  heading.append(icon, headingText);
  const list = block('stia-error-dialog__list');
  const dismissHint = block('stia-error-dialog__dismiss', '点一下关闭');
  root.append(heading, list, dismissHint);
  document.body.append(root);

  let entries = [];
  let returnFocus = null;

  function render() {
    const tone = ['danger', 'warning', 'info'].find(value => entries.some(entry => entry.tone === value))
      || 'warning';
    root.dataset.tone = tone;
    icon.textContent = TONE_ICONS[tone];
    headingText.textContent = entries.length === 1
      ? entries[0].title
      : `画笺 · ${entries.length} 条${entries.some(entry => entry.tone === 'info') ? '提醒' : '报错'}`;
    root.setAttribute('aria-label', headingText.textContent);
    list.replaceChildren(...entries.map(entry => {
      const item = block(`stia-error-dialog__item is-${entry.tone}`);
      if (entries.length > 1 || entry.count > 1) {
        const title = document.createElement('strong');
        title.className = 'stia-error-dialog__entry-title';
        title.textContent = entry.count > 1 ? `${entry.title}（×${entry.count}）` : entry.title;
        item.append(title);
      }
      item.append(block('stia-error-dialog__message', entry.message));
      if (entry.hint) item.append(block('stia-error-dialog__hint', entry.hint));
      if (entry.retries.size) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'stia-button stia-button--primary stia-error-dialog__retry';
        retry.textContent = entry.retries.size > 1 ? '↻ 全部重新生成' : '↻ 重新生成';
        retry.addEventListener('click', event => {
          event.stopPropagation();
          retryEntry(entry);
        });
        item.append(retry);
      }
      if (entry.view) {
        const view = document.createElement('button');
        view.type = 'button';
        view.className = 'stia-button stia-button--primary stia-error-dialog__view';
        view.textContent = '⌕ 查看';
        view.addEventListener('click', event => {
          event.stopPropagation();
          viewEntry(entry);
        });
        item.append(view);
      }
      return item;
    }));
  }

  /* 原图查看器不在浏览器顶层，弹窗开着会挡住它，所以先整个关掉再打开原图。 */
  function viewEntry(entry) {
    close();
    try {
      entry.view();
    } catch (error) {
      console.warn('[画笺] 无法打开原图', error);
    }
  }

  /* 只收起这一条再重跑；别的报错还留在弹窗里。重跑失败会再弹一次，这里不必再管。 */
  function retryEntry(entry) {
    const runs = [...entry.retries.values()];
    entries = entries.filter(item => item !== entry);
    if (entries.length) {
      render();
      root.focus({ preventScroll: true });
    } else {
      close();
    }
    for (const run of runs) {
      try {
        void Promise.resolve(run()).catch(() => {});
      } catch {
        // 同步抛错同样会由生图流程自己报出来。
      }
    }
  }

  function addRetry(entry, retry) {
    if (typeof retry?.run !== 'function') return;
    entry.retries.set(retry.key ?? `retry-${entry.retries.size}`, retry.run);
  }

  function open() {
    if (!root.isConnected) document.body.append(root);
    root.hidden = false;
    try {
      if (typeof root.showModal === 'function') {
        if (!root.hasAttribute('open')) root.showModal();
      } else {
        root.setAttribute('open', '');
      }
    } catch {
      root.setAttribute('open', '');
    }
    root.focus({ preventScroll: true });
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    entries = [];
    list.replaceChildren();
    if (root.hasAttribute('open')) {
      if (typeof root.close === 'function') root.close();
      else root.removeAttribute('open');
    }
    /* 酒馆会把 toast 提示容器挪进最后打开的 <dialog>；关掉时还回 body，免得酒馆的提示跟着看不见。 */
    const toasts = root.querySelector('#toast-container');
    if (toasts) document.body.append(toasts);
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function show(problem) {
    if (!problem?.message) return;
    const { retry, view, ...details } = problem;
    /* 画好的每张图各占一条，各自「查看」；报错按标题和内容合并计次。 */
    const key = [details.title, details.message, details.resultId || ''].join('\n');
    let entry = entries.find(item => item.key === key);
    if (entry) {
      entry.count += 1;
    } else {
      entry = { ...details, key, count: 1, retries: new Map(), view: null };
      entries = [...entries, entry].slice(-MAX_ENTRIES);
    }
    addRetry(entry, retry);
    if (typeof view === 'function') entry.view = view;
    render();
    if (!root.hidden && root.hasAttribute('open')) return;
    if (root.hidden) returnFocus = document.activeElement;
    open();
  }

  /* 点弹窗任意位置或背景都关（点背景时事件也落在 dialog 上）；拖选文字想复制时不关。 */
  root.addEventListener('click', () => {
    const selection = document.getSelection?.();
    if (selection && !selection.isCollapsed && root.contains(selection.anchorNode)) return;
    close();
  });
  root.addEventListener('keydown', event => {
    if (event.target !== root || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    close();
  });
  /* 浏览器自己关掉（安卓返回手势、Esc 的默认行为等）时同步状态。 */
  root.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  /* close 事件是异步派发的：关掉后马上又弹了新报错时，这个迟到的事件不能把新弹窗关掉。 */
  root.addEventListener('close', () => {
    if (!root.hasAttribute('open')) close();
  });
  /* 捕获阶段拦下 Escape：只关弹窗，不连带关掉下面的设置窗口。 */
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || root.hidden) return;
    event.stopPropagation();
    close();
  }, true);

  return { show, close, root };
}
