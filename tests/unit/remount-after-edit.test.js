/* 改写后重挂载回归 —— Claude Opus 5
   现有用例都只覆盖「第一次」。这个 bug 出在「第二次」：
   MESSAGE_EDITED 抢在酒馆用 mes 重建 DOM 之前到达，mount 对着旧 DOM
   判定无事可做直接退出；等重建发生，事件已经消耗掉，原文就一直露着。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMessageRenderer } from '../../src/ui/renderer/message-renderer.js';

const MES = '他把折扇收进腰间。\n\n<draw> masterpiece, a young lord on the threshold </draw>';
const TAGS = [{ tagId: 'tag-1', prompt: 'masterpiece, a young lord on the threshold', ordinal: 0, count: 1 }];

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><div id="chat"></div>', { url: 'http://localhost' });
  /* 每个用例都重挂一次全局：node --test 会并行跑多个文件，
     只在模块顶层挂一次的话会被别的测试文件覆盖，出现「单跑绿、合跑红」。 */
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'CSS', 'HTMLElement', 'Element', 'Range']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  if (!globalThis.CSS?.escape) {
    globalThis.CSS = { escape: value => String(value).replace(/[^\w-]/g, ch => `\\${ch}`) };
  }
  const message = dom.window.document.createElement('div');
  message.className = 'mes';
  message.setAttribute('mesid', '0');
  message.innerHTML = '<div class="mes_text"></div>';
  dom.window.document.querySelector('#chat').appendChild(message);
  const container = message.querySelector('.mes_text');
  const rebuild = () => { container.innerHTML = MES.split('\n\n').map(p => `<p>${p}</p>`).join(''); };
  rebuild();
  const renderer = createMessageRenderer({
    compat: { messageElement: () => message, chat: () => [{ mes: MES }] },
    api: {},
    store: { state: { tagStates: new Map(), settings: {} }, subscribe() {}, setTag() {}, set() {} },
    actions: {},
  });
  return { dom, container, renderer, rebuild };
}

test('DOM 从 mes 重建之后，再挂载能把 <draw> 换成卡片', () => {
  const { container, renderer, rebuild } = setup();
  renderer.mount('0', TAGS);
  rebuild();
  assert.ok(container.querySelector('draw'), '重建后 <draw> 应该回来了');

  const result = renderer.mount('0', TAGS);
  assert.equal(result.fallback, 0, '不该掉进楼底 fallback');
  assert.equal(container.querySelector('draw'), null, '<draw> 必须被替换掉');
  assert.ok(container.querySelector('.stia-card'), '卡片要回到原地');
});

test('卡片错位到楼底的坏状态必须能自愈', () => {
  const { dom, container, renderer, rebuild } = setup();
  rebuild();
  const list = dom.window.document.createElement('div');
  list.className = 'stia-card-list';
  const orphan = dom.window.document.createElement('div');
  orphan.className = 'stia-card';
  orphan.setAttribute('data-tag-id', 'tag-1');
  list.appendChild(orphan);
  container.appendChild(list);

  renderer.mount('0', TAGS);
  assert.equal(container.querySelector('draw'), null, '<draw> 不该继续露着');
  assert.equal(container.querySelector('.stia-card-list'), null, '空的 fallback 列表要清掉');
  assert.ok(container.querySelector('.stia-card'), '卡片要回到原地');
});

test('已经挂好且没有孤儿 <draw> 时，不做无谓重挂', () => {
  const { container, renderer } = setup();
  renderer.mount('0', TAGS);
  const before = container.innerHTML;
  const result = renderer.mount('0', TAGS);
  assert.equal(result.mounted, 0, '干净状态下应当直接返回');
  assert.equal(container.innerHTML, before, 'DOM 不该被动过');
});

/* 空行拆段回归 —— 提示词模板里有空行时，酒馆渲染成多个 <p>，
   <draw> 被 HTML 解析器隐式闭合，只包住第一行，后面几段变成裸段落。 */
const SPLIT_PROMPT = 'masterpiece, 8k.\nRefined illustration.\na young lord on the threshold';
const SPLIT_TAGS = [{ tagId: 'tag-1', prompt: SPLIT_PROMPT, ordinal: 0, count: 1 }];
const SPLIT_HTML = '<p>他把折扇收进腰间。</p><p><draw> masterpiece, 8k.</p>'
  + '<p>Refined illustration.</p><p>a young lord on the threshold </draw></p>';

function setupSplit(html = SPLIT_HTML) {
  const { dom, container, renderer } = setup();
  container.innerHTML = html;
  return { dom, container, renderer };
}

test('模板含空行导致 <draw> 跨段落时，残肢也要被清掉', () => {
  const { container, renderer } = setupSplit();
  renderer.mount('0', SPLIT_TAGS);
  const cardText = container.querySelector('.stia-card')?.textContent || '';
  const leaked = container.textContent.replace(cardText, '').replace('他把折扇收进腰间。', '').trim();
  assert.equal(leaked, '', '提示词残段不该留在楼里');
  assert.ok(container.querySelector('.stia-card'), '卡片要在');
});

test('正文必须原样保留，绝不能被清扫波及', () => {
  const { container, renderer } = setupSplit();
  renderer.mount('0', SPLIT_TAGS);
  assert.ok(container.textContent.includes('他把折扇收进腰间。'), '正文一个字都不能少');
});

test('与提示词字面重合的正文段落不受影响（只删 prompt 内的内容）', () => {
  const { container, renderer } = setupSplit(
    '<p>他说：masterpiece 这个词他不喜欢，太满了。</p>'
    + '<p><draw> masterpiece, 8k.</p><p>Refined illustration.</p>'
    + '<p>a young lord on the threshold </draw></p>',
  );
  renderer.mount('0', SPLIT_TAGS);
  assert.ok(
    container.textContent.includes('他说：masterpiece 这个词他不喜欢'),
    '正文里恰好提到 masterpiece 也不能被误删',
  );
});

/* 消毒器剥标签 + <br> —— 江的真实结构（1.4.5）
   酒馆的 HTML 消毒器把 <draw> 整个剥掉只留文字，DOM 里既无 <draw> 元素、
   文本里也无字面 <draw>；同时单换行渲染成 <br>，而 <br> 不是文本节点，
   DOM 侧拼出来没有空格，提示词侧规范化后有空格，按空格对齐就永远匹配不上。 */
const BR_PROMPT = 'masterpiece, best quality.\nRefined stylized illustration.\nMedium shot, a stone-paved street corner.';
const BR_TAGS = [{ tagId: 'tag-1', prompt: BR_PROMPT, ordinal: 0, count: 1 }];

test('<draw> 被消毒器剥掉、只剩 <br> 分隔的文本时，仍要认出并替换', () => {
  const { container, renderer } = setup();
  container.innerHTML = '<p>他把折扇收进腰间。</p>'
    + '<p>masterpiece, best quality.<br>Refined stylized illustration.'
    + '<br>Medium shot, a stone-paved street corner.</p>';
  const result = renderer.mount('0', BR_TAGS);
  assert.equal(result.fallback, 0, '不该落进楼底 fallback');
  const cardText = container.querySelector('.stia-card')?.textContent || '';
  const leaked = container.textContent.replace(cardText, '').replace('他把折扇收进腰间。', '').trim();
  assert.equal(leaked, '', '提示词不该留在楼里');
  assert.ok(container.textContent.includes('他把折扇收进腰间。'), '正文必须原样保留');
});

test('<draw> 作为元素存活时，原路径依然有效', () => {
  const { container, renderer } = setup();
  container.innerHTML = '<p>他把折扇收进腰间。</p>'
    + '<p><draw> masterpiece, best quality.<br>Refined stylized illustration.'
    + '<br>Medium shot, a stone-paved street corner. </draw></p>';
  renderer.mount('0', BR_TAGS);
  assert.equal(container.querySelector('draw'), null, '<draw> 要被替换');
  assert.ok(container.textContent.includes('他把折扇收进腰间。'), '正文必须原样保留');
});
