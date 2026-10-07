/* 「查看提示词」展开后下面的「一键复制」：消息卡片和原图查看层共用。 */

const COPY_LABEL = '一键复制';

/* 只读：手机上不弹键盘；16px：iPhone 聚焦时不把页面放大；固定在左上角、透明：不挪动页面。 */
const HIDDEN_AREA_STYLE = 'position:fixed;top:0;left:0;width:1px;height:1px;margin:0;padding:0;'
  + 'border:0;opacity:0;font-size:16px;pointer-events:none;';

function legacyCopy(value, documentRef) {
  if (typeof documentRef?.execCommand !== 'function' || !documentRef.body) return false;
  const previousFocus = documentRef.activeElement;
  const area = documentRef.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  area.style.cssText = HIDDEN_AREA_STYLE;
  documentRef.body.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, value.length);
    return documentRef.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
    if (previousFocus && previousFocus !== documentRef.body) previousFocus.focus?.({ preventScroll: true });
  }
}

/* 能用剪贴板接口就用（HTTPS 或本机打开酒馆）；手机用局域网 http 地址打开时浏览器不给这个接口，
   退回老办法：放一个看不见的只读文本框，选中后复制。都不行时返回 false，由按钮提示手动复制。 */
export async function copyText(text, {
  document: documentRef = globalThis.document,
  navigator: navigatorRef = globalThis.navigator,
} = {}) {
  const value = String(text ?? '');
  if (typeof navigatorRef?.clipboard?.writeText === 'function') {
    try {
      await navigatorRef.clipboard.writeText(value);
      return true;
    } catch {
      // 没给剪贴板权限、页面没聚焦等：再用老办法试一次。
    }
  }
  return legacyCopy(value, documentRef);
}

/* 靠右的一行「一键复制」：点了显示「✓ 已复制」，过一会儿变回来；复制不了时提示长按文字手动复制。 */
export function createCopyRow(text, {
  document: documentRef = globalThis.document,
  navigator: navigatorRef = globalThis.navigator,
} = {}) {
  const row = documentRef.createElement('div');
  row.className = 'stia-copy-row';
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = 'stia-button stia-copy';
  button.textContent = COPY_LABEL;
  let timer = null;
  button.addEventListener('click', async () => {
    const copied = await copyText(text, { document: documentRef, navigator: navigatorRef });
    button.textContent = copied ? '✓ 已复制' : '复制失败，请长按文字复制';
    button.className = `stia-button stia-copy ${copied ? 'is-copied' : 'is-failed'}`;
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = COPY_LABEL;
      button.className = 'stia-button stia-copy';
    }, copied ? 1600 : 3200);
    timer?.unref?.();
  });
  row.append(button);
  return row;
}
