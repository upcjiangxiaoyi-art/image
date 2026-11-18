/* 2.6.0 线条图标（src/ui/icons.js）：按钮前面那个小图标是画出来的 SVG，不再用 ↻ ⌕ ▦ 这类符号字符。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ICON_NAMES, icon, setIconLabel } from '../../src/ui/icons.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function page(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  t.after(() => dom.window.close());
  return dom.window.document;
}

test('每个图标都画得出来：24 格、描边、颜色跟着文字走、读屏软件不读', t => {
  const document = page(t);
  assert.ok(ICON_NAMES.length >= 30);
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
  for (const name of ICON_NAMES) {
    const node = icon(name, { document });
    assert.equal(node.tagName.toLowerCase(), 'svg', name);
    assert.equal(node.namespaceURI, 'http://www.w3.org/2000/svg', name);
    assert.equal(node.getAttribute('viewBox'), '0 0 24 24', name);
    assert.equal(node.getAttribute('stroke'), 'currentColor', `${name}：颜色跟着按钮上的字`);
    assert.equal(node.getAttribute('fill'), 'none', name);
    assert.equal(node.getAttribute('aria-hidden'), 'true', `${name}：只是装饰`);
    assert.equal(node.getAttribute('focusable'), 'false', name);
    assert.equal(node.dataset.icon, name);
    assert.ok(node.getAttribute('class').split(' ').includes(`stia-icon--${name}`), name);
    assert.ok(node.children.length > 0, `${name} 里面有东西`);
    for (const shape of node.children) {
      assert.ok(['path', 'circle', 'rect'].includes(shape.tagName.toLowerCase()), `${name}：${shape.tagName}`);
      assert.equal(shape.namespaceURI, 'http://www.w3.org/2000/svg', `${name} 的形状是 SVG 元素`);
    }
  }
});

test('图标的几种样子：实心、转圈、加类名；不认识的名字画个空的，不报错', t => {
  const document = page(t);
  const star = icon('star', { filled: true, document });
  assert.equal(star.getAttribute('fill'), 'currentColor', '收藏了的星星是实心的');
  assert.ok(star.getAttribute('class').split(' ').includes('is-filled'));
  assert.ok(icon('spinner', { spin: true, document }).getAttribute('class').split(' ').includes('is-spinning'));
  assert.ok(icon('check', { className: 'mine', document }).getAttribute('class').split(' ').includes('mine'));
  const unknown = icon('没有这个', { document });
  assert.equal(unknown.tagName.toLowerCase(), 'svg');
  assert.equal(unknown.children.length, 0);
});

test('setIconLabel：按钮里换成「图标 + 字」，textContent 只有字', t => {
  const document = page(t);
  const button = document.createElement('button');
  button.textContent = '旧的';
  assert.equal(setIconLabel(button, 'refresh', '重新生成', { document }), button);
  assert.deepEqual([...button.children].map(node => node.tagName.toLowerCase()), ['svg', 'span']);
  assert.equal(button.textContent, '重新生成', '读屏软件、测试看到的都只有字');
  setIconLabel(button, 'check', '已保存', { document });
  assert.equal(button.children.length, 2, '再设一次是换，不是往后加');
  assert.equal(button.querySelector('.stia-icon').dataset.icon, 'check');
});

test('极简的假页面（没有 createElementNS）里退回成一个空 span，不报错', () => {
  const made = [];
  const fake = {
    createElement(tag) {
      const node = { tag, dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
      made.push(node);
      return node;
    },
  };
  const node = icon('grid', { document: fake });
  assert.equal(node.tag, 'span');
  assert.equal(node.className, 'stia-icon stia-icon--grid');
  assert.equal(node.dataset.icon, 'grid');
  assert.equal(node.attributes['aria-hidden'], 'true');
});

/* 去掉注释再找：注释里可以提这些符号，界面上不能再用。 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(target));
    else if (entry.name.endsWith('.js')) found.push(target);
  }
  return found;
}

test('界面代码里不再拿符号字符当图标', async () => {
  const glyphs = /[↻⌕▦◫▤⇄★☆✓✎‹›⇧⇩●○◐▸▾]/u;
  const files = [...await sourceFiles(path.join(root, 'src/ui')), path.join(root, 'index.js')];
  assert.ok(files.length > 20);
  for (const file of files) {
    const lines = withoutComments(await fs.readFile(file, 'utf8')).split('\n');
    const hit = lines.find(line => glyphs.test(line));
    assert.equal(hit, undefined, `${path.relative(root, file)}：${hit?.trim()}`);
  }
});

test('源码里用到的图标名字图标表里都有', async () => {
  const known = new Set(ICON_NAMES);
  const files = await sourceFiles(path.join(root, 'src/ui'));
  const used = new Set();
  for (const file of files) {
    const source = withoutComments(await fs.readFile(file, 'utf8'));
    /* icon('名字'…)、drawIcon('名字')、statusHeading('名字', …)、sectionTitle('名字', …)、setIconLabel(元素, '名字', …)。
       当最后一个参数传给 button() 那些的，由各页面自己的测试看（blankIcons）。 */
    for (const match of source.matchAll(/\b(?:icon|drawIcon|sectionTitle|statusHeading)\(\s*'([a-z][a-z-]*)'/g)) used.add(match[1]);
    for (const match of source.matchAll(/\bsetIconLabel\(\s*[\w.]+\s*,\s*(?:[\w.]+\s*\?\s*)?'([a-z][a-z-]*)'(?:\s*:\s*'([a-z][a-z-]*)')?/g)) {
      used.add(match[1]);
      if (match[2]) used.add(match[2]);
    }
  }
  assert.ok(used.size >= 15, `扫到 ${used.size} 个`);
  assert.deepEqual([...used].filter(name => !known.has(name)), []);
});
