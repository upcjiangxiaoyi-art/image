import { createCopyRow } from './copy-text.js';
import { icon } from '../icons.js';

const HISTORY_KEY = 'stImageAtelierViewer';
let activeViewer = null;

function extensionForMime(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function safeFilename(value, extension) {
  const base = String(value || 'image-atelier')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image-atelier';
  return `${base}.${extension}`;
}

/* iconName 给了就是「图标 + 字」。图标只是装饰，测试用的极简假页面里不画。 */
function createButton(documentRef, label, className, handler, iconName = '') {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = className;
  if (iconName && typeof button.replaceChildren === 'function') {
    const text = documentRef.createElement('span');
    text.textContent = label;
    button.replaceChildren(icon(iconName, { document: documentRef }), text);
  } else {
    button.textContent = label;
  }
  button.addEventListener('click', handler);
  return button;
}

export function makeImageSaveable(image, onOpen) {
  image.classList.add('stia-saveable-image');
  image.draggable = true;
  if (typeof onOpen !== 'function') return image;
  image.tabIndex = 0;
  image.setAttribute('role', 'button');
  image.setAttribute('aria-label', '查看原图；手机可长按图片保存');
  image.addEventListener('click', onOpen);
  image.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen();
  });
  return image;
}

/* 手指横着划过多少像素才算翻一张（再少就当成点了一下）。 */
const SWIPE_DISTANCE = 48;
const SINGLE_HINT = '点一下图片放大，长按图片保存';
const SEQUENCE_HINT = '左右滑换一张，点一下放大，长按保存';

function emptyOut(element) {
  if (typeof element.replaceChildren === 'function') element.replaceChildren();
  else for (const child of [...element.children]) child.remove();
}

/* options：src、alt、filename、prompt、meta、onJump、jumpLabel、onDelete、onClose；
   remote: true 表示图在别处的链接上（没存进酒馆）：不给「分享、保存」（脚本下载不了它，分享不了），
   要图时不带来源页地址（有的图床看到别的网站来要图会拒绝）。
   想让人在查看器里左右翻，再给两个函数（都按「现在」的列表现算，中途删了图也对）：
   - neighbor(delta)：往前（-1）或往后（1）那一张的 options，没有就返回 null；
   - position()：这张是第几张，{ index, total }；不在列表里了返回 null。 */
export function openImageViewer(options, environment = {}) {
  const documentRef = environment.document || globalThis.document;
  const windowRef = environment.window || globalThis.window;
  const navigatorRef = environment.navigator || globalThis.navigator;
  const fetchRef = environment.fetch || globalThis.fetch;
  const FileRef = environment.File || globalThis.File;
  if (!documentRef?.body) throw new Error('当前页面无法打开原图查看器');

  activeViewer?.destroy();

  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const previousFocus = documentRef.activeElement;
  const previousBodyOverflow = documentRef.body.style.overflow;
  const previousRootOverflow = documentRef.documentElement?.style?.overflow || '';
  let closed = false;
  let historyPushed = false;
  /* 正在看的那张的 options。 */
  let current = options;
  /* 「查看提示词」展开着翻到下一张：下一张也展开，方便对着看。 */
  let promptOpen = false;
  /* 图片元素上现在放的是哪个地址（不读 image.src：浏览器会把它补成完整网址，比不出来）。 */
  let shownSrc = null;

  const overlay = documentRef.createElement('section');
  overlay.className = 'stia-image-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '查看原图');

  const toolbar = documentRef.createElement('header');
  toolbar.className = 'stia-image-viewer__toolbar';
  const title = documentRef.createElement('strong');
  title.textContent = '查看原图';
  const close = createButton(
    documentRef,
    '关闭',
    'stia-image-viewer__close',
    () => requestClose(),
    'close',
  );
  close.setAttribute('aria-label', '关闭原图并返回酒馆页面');
  close.title = '关闭';
  toolbar.append(title, close);

  /* 图片那一块：图在 stage 里（放大后 stage 自己上下滚），左右两个箭头压在它上面、不跟着滚。 */
  const body = documentRef.createElement('div');
  body.className = 'stia-image-viewer__body';
  const stage = documentRef.createElement('div');
  stage.className = 'stia-image-viewer__stage';
  const image = documentRef.createElement('img');
  image.className = 'stia-image-viewer__image stia-saveable-image';
  image.draggable = true;
  /* 打开时整张图放进屏幕；点一下放大（最宽占满屏幕，上下滑着看），再点一下回来。长按保存不受影响。 */
  image.addEventListener('click', () => {
    if (stage.classList.contains('is-zoomed')) stage.classList.remove('is-zoomed');
    else stage.classList.add('is-zoomed');
  });
  const settled = () => image.classList.remove('is-loading');
  image.addEventListener('load', settled);
  image.addEventListener('error', settled);
  stage.append(image);
  const arrow = (label, className, iconName, delta) => {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = `stia-image-viewer__nav ${className}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(iconName, { document: documentRef }));
    button.addEventListener('click', () => go(delta));
    return button;
  };
  const previousArrow = arrow('上一张', 'is-prev', 'chevron-left', -1);
  const nextArrow = arrow('下一张', 'is-next', 'chevron-right', 1);
  body.append(stage, previousArrow, nextArrow);

  const footer = documentRef.createElement('footer');
  footer.className = 'stia-image-viewer__footer';
  const hint = documentRef.createElement('p');
  hint.className = 'stia-image-viewer__hint';
  const status = documentRef.createElement('p');
  status.className = 'stia-image-viewer__status';
  status.setAttribute('role', 'status');

  function neighborOf(target, delta) {
    if (typeof target?.neighbor !== 'function') return null;
    try {
      return target.neighbor(delta) || null;
    } catch {
      return null;
    }
  }

  function positionOf(target) {
    if (typeof target?.position !== 'function') return null;
    try {
      const position = target.position();
      return position && Number.isInteger(position.index) && position.total > 1 ? position : null;
    } catch {
      return null;
    }
  }

  /* 底下那几行都跟着正在看的这张：信息、提示词、几个按钮。 */
  function renderFooter() {
    const shown = current;
    emptyOut(footer);
    status.textContent = '';
    if (shown.meta) {
      const meta = documentRef.createElement('p');
      meta.className = 'stia-image-viewer__meta';
      meta.textContent = shown.meta;
      footer.append(meta);
    }
    if (shown.prompt) {
      const details = documentRef.createElement('details');
      details.className = 'stia-image-viewer__prompt';
      details.open = promptOpen;
      details.addEventListener('toggle', () => { promptOpen = details.open === true; });
      const summary = documentRef.createElement('summary');
      summary.textContent = '查看提示词';
      const prompt = documentRef.createElement('pre');
      prompt.textContent = shown.prompt;
      details.append(summary, prompt, createCopyRow(shown.prompt, { document: documentRef, navigator: navigatorRef }));
      footer.append(details);
    }

    const actions = documentRef.createElement('div');
    actions.className = 'stia-image-viewer__actions';
    if (shown.remote !== true && typeof navigatorRef?.share === 'function' && typeof FileRef === 'function' && typeof fetchRef === 'function') {
      const share = createButton(documentRef, '分享、保存', 'stia-button stia-button--primary', async () => {
        share.disabled = true;
        status.textContent = '正在准备原图…';
        try {
          const response = await fetchRef(shown.src, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const file = new FileRef(
            [blob],
            safeFilename(shown.filename, extensionForMime(blob.type)),
            { type: blob.type || 'image/png' },
          );
          const payload = { files: [file], title: '画笺原图' };
          if (typeof navigatorRef.canShare === 'function' && !navigatorRef.canShare(payload)) {
            throw new Error('当前浏览器不支持分享图片文件');
          }
          await navigatorRef.share(payload);
          if (current === shown) status.textContent = '';
        } catch (error) {
          if (error?.name !== 'AbortError' && current === shown) {
            status.textContent = '系统分享不可用，请长按图片保存。';
          }
        } finally {
          share.disabled = false;
        }
      }, 'share');
      actions.append(share);
    }
    /* onJump：跳到这张图所在的楼层。返回 true 就关掉看图器；返回一句话就留在这里把它写出来。 */
    if (typeof shown.onJump === 'function') {
      const jump = createButton(documentRef, shown.jumpLabel || '跳到所在楼层', 'stia-button', async () => {
        jump.disabled = true;
        status.textContent = '正在找这一楼…';
        try {
          const outcome = await shown.onJump();
          if (outcome === true) {
            requestClose();
            return;
          }
          if (current === shown) status.textContent = typeof outcome === 'string' && outcome ? outcome : '没找到这张图所在的楼层';
        } catch (error) {
          if (current === shown) status.textContent = error?.message || '跳转失败';
        } finally {
          jump.disabled = false;
        }
      }, 'locate');
      actions.append(jump);
    }
    if (typeof shown.onDelete === 'function') {
      const remove = createButton(documentRef, '删除', 'stia-button stia-button--danger', async () => {
        remove.disabled = true;
        /* 删之前先记下旁边那张：删完这张就不在列表里了，找不到自己原来排在哪。 */
        const after = neighborOf(shown, 1) || neighborOf(shown, -1);
        try {
          const deleted = await shown.onDelete();
          if (deleted === false || closed || current !== shown) return;
          /* 翻着看时删掉一张：接着看旁边那张；一张不剩才关。 */
          if (after) show(after);
          else requestClose();
        } catch (error) {
          if (current === shown) status.textContent = error?.message || '删除失败';
        } finally {
          remove.disabled = false;
        }
      }, 'trash');
      actions.append(remove);
    }
    /* 顶上的关闭键单手够不着，底下再放一个。 */
    const footerClose = createButton(
      documentRef,
      '关闭',
      'stia-button stia-image-viewer__dismiss',
      () => requestClose(),
      'close',
    );
    footerClose.setAttribute('aria-label', '关闭原图并返回酒馆页面');
    actions.append(footerClose);
    footer.append(status, actions, hint);
  }

  /* 换成 target 这张：图、标题里的「第几张」、两边的箭头、底下那几行一起换；放大着的回到整张。 */
  function show(target, { initial = false } = {}) {
    current = target;
    stage.classList.remove('is-zoomed');
    if (stage.scrollTop) stage.scrollTop = 0;
    if (shownSrc !== target.src) {
      /* 新图没载好之前浏览器还显示着旧图：先淡下去，免得底下的信息已经换了、图还是上一张的样子。 */
      if (!initial) image.classList.add('is-loading');
      shownSrc = target.src;
      image.referrerPolicy = target.remote === true ? 'no-referrer' : '';
      image.src = target.src;
    }
    image.alt = target.alt || '生成图片原图';
    const position = positionOf(target);
    title.textContent = position ? `${position.index + 1} / ${position.total}` : '查看原图';
    const before = neighborOf(target, -1);
    const after = neighborOf(target, 1);
    previousArrow.hidden = !before;
    nextArrow.hidden = !after;
    hint.textContent = before || after ? SEQUENCE_HINT : SINGLE_HINT;
    renderFooter();
  }

  /* 往前（-1）或往后（1）翻一张；到头了就停，不绕回去。翻过去以后把再下一张先载上，接着翻不用等。 */
  function go(delta) {
    if (closed) return false;
    const target = neighborOf(current, delta);
    if (!target) return false;
    show(target);
    const ahead = neighborOf(target, delta);
    const ImageRef = environment.Image || (environment.document ? null : globalThis.Image);
    if (ahead?.src && typeof ImageRef === 'function') {
      try {
        new ImageRef().src = ahead.src;
      } catch {
        // 预载只是为了快，失败了不要紧。
      }
    }
    return true;
  }

  show(options, { initial: true });
  overlay.append(toolbar, body, footer);

  function destroy() {
    if (closed) return;
    closed = true;
    windowRef?.removeEventListener?.('keydown', onKeydown);
    windowRef?.removeEventListener?.('popstate', onPopState);
    overlay.remove();
    documentRef.body.classList.remove('stia-image-viewer-open');
    documentRef.body.style.overflow = previousBodyOverflow;
    if (documentRef.documentElement?.style) {
      documentRef.documentElement.style.overflow = previousRootOverflow;
    }
    previousFocus?.focus?.();
    if (activeViewer?.token === token) activeViewer = null;
    /* 告诉来的地方：关掉时看的是哪一张（翻过的话不是打开时那张）。 */
    current.onClose?.();
  }

  function requestClose() {
    if (closed) return;
    const shouldReturn = historyPushed && windowRef?.history?.state?.[HISTORY_KEY] === token;
    destroy();
    if (shouldReturn) windowRef.history.back();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') requestClose();
    else if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
  }

  function onPopState() {
    destroy();
  }

  stage.addEventListener('click', event => {
    if (event.target === stage) requestClose();
  });
  /* 左右滑：只认一根手指、主要是横着动、动得够远的。不拦事件（passive），长按保存、捏合缩放、点一下放大都照旧。
     放大着的时候是在上下滑着看图，不翻。 */
  let touchStart = null;
  body.addEventListener('touchstart', event => {
    const touches = event.touches || [];
    touchStart = touches.length === 1 && !stage.classList.contains('is-zoomed')
      ? { x: touches[0].clientX, y: touches[0].clientY }
      : null;
  }, { passive: true });
  body.addEventListener('touchend', event => {
    const from = touchStart;
    touchStart = null;
    const touch = event.changedTouches?.[0];
    if (!from || !touch) return;
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    go(dx < 0 ? 1 : -1);
  }, { passive: true });
  body.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
  windowRef?.addEventListener?.('keydown', onKeydown);
  windowRef?.addEventListener?.('popstate', onPopState);
  documentRef.body.classList.add('stia-image-viewer-open');
  documentRef.body.style.overflow = 'hidden';
  if (documentRef.documentElement?.style) documentRef.documentElement.style.overflow = 'hidden';
  documentRef.body.append(overlay);
  close.focus?.();

  try {
    windowRef?.history?.pushState?.({ ...(windowRef.history.state || {}), [HISTORY_KEY]: token }, '');
    historyPushed = windowRef?.history?.state?.[HISTORY_KEY] === token;
  } catch {
    historyPushed = false;
  }

  const controller = { token, root: overlay, image, close: requestClose, destroy };
  activeViewer = controller;
  return controller;
}
