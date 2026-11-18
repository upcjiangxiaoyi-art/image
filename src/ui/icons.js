/* 画笺自己的一套线条图标。以前用的是 ↻ ⌕ ▦ ◫ 这类符号字符：各家字体画得不一样，粗细大小对不齐，
   有的在手机上还会变成彩色表情。这里统一成 24 格的描边图标：线宽一样、圆头圆角、颜色跟着文字走。
   都是自己画的简单几何形，没有抄别家的图标库。
   图标只是装饰（aria-hidden），按钮上的字才是给人和读屏软件看的。 */
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = Object.freeze({
  /* 重新生成、再画一张、重试 */
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.6h-4.6"/>',
  /* 原图 */
  expand: '<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>',
  /* 画廊 */
  grid: '<rect x="4" y="4" width="6.8" height="6.8" rx="1.6"/><rect x="13.2" y="4" width="6.8" height="6.8" rx="1.6"/><rect x="4" y="13.2" width="6.8" height="6.8" rx="1.6"/><rect x="13.2" y="13.2" width="6.8" height="6.8" rx="1.6"/>',
  /* 参考图、参考重画：相框里一个人像 */
  portrait: '<rect x="4" y="4" width="16" height="16" rx="3.2"/><circle cx="12" cy="10" r="2.5"/><path d="M7.4 17.6c.8-2.4 2.5-3.7 4.6-3.7s3.8 1.3 4.6 3.7"/>',
  /* 预设、API 配置 */
  sliders: '<path d="M4 7.5h9.5M18.5 7.5H20M4 16.5h1.5M10.5 16.5H20"/><circle cx="16" cy="7.5" r="2.4"/><circle cx="8" cy="16.5" r="2.4"/>',
  /* 调整后重绘 */
  pencil: '<path d="M4.5 19.5l.9-4L16.3 4.6a2 2 0 0 1 2.9 0l.2.2a2 2 0 0 1 0 2.9L8.5 18.6z"/><path d="M14.6 6.3l3.1 3.1"/>',
  /* 换备用线路 */
  swap: '<path d="M4.5 8.2h14M15.2 4.8l3.4 3.4-3.4 3.4"/><path d="M19.5 15.8h-14M8.8 12.4l-3.4 3.4 3.4 3.4"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  'chevron-left': '<path d="M14.5 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6 9.5l6 6 6-6"/>',
  /* 排队 */
  clock: '<circle cx="12" cy="12" r="7.8"/><path d="M12 7.8V12l2.8 2.4"/>',
  /* 正在画：转着的四分之三圈 */
  spinner: '<path d="M12 4.2A7.8 7.8 0 1 0 19.8 12"/>',
  /* 生成图片、生图参数：一颗大星带一颗小星 */
  sparkles: '<path d="M10.5 4.5l1.6 4.3 4.4 1.7-4.4 1.7-1.6 4.3-1.6-4.3-4.4-1.7 4.4-1.7z"/><path d="M17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2.6"/><circle cx="9" cy="10" r="1.6"/><path d="M4.8 17l4.7-4.6 3 2.9 2.4-2.3 4.3 4.2"/>',
  /* 取消、关闭 */
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  /* 删除 */
  trash: '<path d="M4.5 7.2h15M9.8 7.2V5.4a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1v1.8"/><path d="M6.6 7.2l.8 11a1.6 1.6 0 0 0 1.6 1.4h6a1.6 1.6 0 0 0 1.6-1.4l.8-11M10.2 11v5M13.8 11v5"/>',
  check: '<path d="M5.2 12.6l4.4 4.4 9.2-9.6"/>',
  star: '<path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z"/>',
  /* 设置 */
  gear: '<circle cx="12" cy="12" r="2.8"/><path d="M12 3.8v2.4M12 17.8v2.4M3.8 12h2.4M17.8 12h2.4M6.2 6.2l1.7 1.7M16.1 16.1l1.7 1.7M6.2 17.8l1.7-1.7M16.1 7.9l1.7-1.7"/><circle cx="12" cy="12" r="6.2"/>',
  /* 测试接口 */
  bolt: '<path d="M13.2 3.8L5.6 13.4h5.2l-.9 6.8 7.9-9.8h-5.4z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.4"/>',
  /* 界面主题：半明半暗的圆 */
  contrast: '<circle cx="12" cy="12" r="7.8"/><path d="M12 4.2a7.8 7.8 0 0 1 0 15.6z" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.4"/><path d="M15.5 8.5V6.6a2.1 2.1 0 0 0-2.1-2.1H6.6a2.1 2.1 0 0 0-2.1 2.1v6.8a2.1 2.1 0 0 0 2.1 2.1h1.9"/>',
  /* 整理旧数据：收纳盒 */
  archive: '<rect x="3.8" y="4.5" width="16.4" height="4.4" rx="1.4"/><path d="M5.2 8.9v8.9a1.7 1.7 0 0 0 1.7 1.7h10.2a1.7 1.7 0 0 0 1.7-1.7V8.9M10 12.8h4"/>',
  alert: '<path d="M12 4.6l8.2 14.2H3.8z"/><path d="M12 10.4v3.8M12 16.6v.2"/>',
  info: '<circle cx="12" cy="12" r="7.8"/><path d="M12 11v5M12 7.9v.2"/>',
  /* 弹窗标题前的小圆点里用：一个感叹号 */
  exclaim: '<path d="M12 5.6v8M12 17.9v.2"/>',
  search: '<circle cx="10.8" cy="10.8" r="6"/><path d="M19.5 19.5l-4.4-4.4"/>',
  /* 跳到所在楼层 */
  locate: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.4"/><path d="M12 2.8v1.8M12 19.4v1.8M2.8 12h1.8M19.4 12h1.8"/>',
  filter: '<path d="M4.5 6h15l-5.8 6.8v5l-3.4 1.7v-6.7z"/>',
  /* 批量选择 */
  select: '<rect x="4" y="4" width="16" height="16" rx="3.2"/><path d="M8.2 12.3l2.7 2.7 5-5.3"/>',
  /* 分享 / 保存 */
  share: '<path d="M12 14.5V4.2M8.2 7.8L12 4.2l3.8 3.6"/><path d="M6.5 11.5v6.2a1.8 1.8 0 0 0 1.8 1.8h7.4a1.8 1.8 0 0 0 1.8-1.8v-6.2"/>',
  /* 自动生图 */
  wand: '<path d="M4.8 19.2L15.4 8.6M13.6 6.8l3.6 3.6"/><path d="M18.4 3.8v2.6M17.1 5.1h2.6M7 4.6v2M6 5.6h2M19 13.6v2M18 14.6h2"/>',
  /* 清理 */
  broom: '<path d="M19.2 4.8l-7 7M9.6 9.8l4.6 4.6M9.6 9.8L4.5 16l3.5 3.5 6.2-5.1"/><path d="M6.6 14.4l3 3"/>',
  /* 只看这个聊天 */
  chat: '<path d="M7.2 4.8h9.6a2.7 2.7 0 0 1 2.7 2.7v6.2a2.7 2.7 0 0 1-2.7 2.7h-4.9l-4.2 3.3v-3.3h-.5a2.7 2.7 0 0 1-2.7-2.7V7.5a2.7 2.7 0 0 1 2.7-2.7z"/>',
  /* 批量下载 */
  download: '<path d="M12 4.5v10.3M8.2 11.2l3.8 3.6 3.8-3.6"/><path d="M5 18.8h14"/>',
  /* 数据文件 */
  files: '<path d="M8.5 4.5h6l4 4v8.2a1.8 1.8 0 0 1-1.8 1.8H8.5a1.8 1.8 0 0 1-1.8-1.8V6.3a1.8 1.8 0 0 1 1.8-1.8z"/><path d="M14.5 4.5v4h4M4.5 8v10.2a2.3 2.3 0 0 0 2.3 2.3h7.4"/>',
});

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

/* 一个图标元素。name 不认识就画一个空的占位，不抛错。
   filled：实心（收藏了的星星）。spin：转着的（正在画）。document：不在当前页面里画时传进来。
   测试里用的极简假 DOM 没有 createElementNS，退回成一个带名字的空 span。 */
export function icon(name, { filled = false, spin = false, className = '', document: documentRef = globalThis.document } = {}) {
  const classes = ['stia-icon', `stia-icon--${name}`, filled ? 'is-filled' : '', spin ? 'is-spinning' : '', className]
    .filter(Boolean)
    .join(' ');
  if (typeof documentRef?.createElementNS !== 'function') {
    const fallback = documentRef.createElement('span');
    fallback.className = classes;
    fallback.setAttribute?.('aria-hidden', 'true');
    if (fallback.dataset) fallback.dataset.icon = name;
    return fallback;
  }
  const svg = documentRef.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', classes);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.dataset.icon = name;
  svg.innerHTML = PATHS[name] || '';
  return svg;
}

/* 把 label 元素的内容换成「图标 + 文字」。 */
export function setIconLabel(element, name, text, options) {
  const label = (options?.document || globalThis.document).createElement('span');
  label.textContent = text;
  element.replaceChildren(icon(name, options), label);
  return element;
}
