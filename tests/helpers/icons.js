/* 图标是 src/ui/icons.js 画的 SVG，按钮的 textContent 里只有字。测试里想看「哪个按钮配了哪个图标」用这两个。 */

/* 按钮（或任意元素）上那个图标的名字；没有就是空串。 */
export function iconOf(element) {
  return element?.querySelector?.('.stia-icon')?.dataset?.icon || '';
}

/* root 里画不出来的图标（名字写错、图标表里没有）：正常应该是空数组。 */
export function blankIcons(root) {
  return [...root.querySelectorAll('.stia-icon')]
    .filter(node => node.tagName.toLowerCase() !== 'svg' || node.childNodes.length === 0)
    .map(node => node.dataset?.icon || node.getAttribute('class'));
}
