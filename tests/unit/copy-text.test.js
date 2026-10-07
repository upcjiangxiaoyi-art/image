import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { copyText, createCopyRow } from '../../src/ui/media/copy-text.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function page(t) {
  const dom = new JSDOM('<!doctype html><html><body><button id="copy">复制</button></body></html>');
  t.after(() => dom.window.close());
  return dom.window.document;
}

test('一键复制：浏览器有剪贴板接口时直接用，不放临时文本框', async t => {
  const document = page(t);
  const written = [];
  const clipboard = { writeText: async text => { written.push(text); } };
  assert.equal(await copyText('a cat, 雨夜', { document, navigator: { clipboard } }), true);
  assert.deepEqual(written, ['a cat, 雨夜']);
  assert.equal(document.querySelector('textarea'), null);
});

test('手机用局域网 http 打开酒馆时没有剪贴板接口：退回只读文本框选中复制，用完就删、焦点放回去', async t => {
  const document = page(t);
  const button = document.querySelector('#copy');
  button.focus();
  let seen = null;
  document.execCommand = command => {
    const area = document.activeElement;
    seen = {
      command,
      tag: area.tagName,
      readonly: area.hasAttribute('readonly'),
      selected: area.value.slice(area.selectionStart, area.selectionEnd),
      fontSize: area.style.fontSize,
    };
    return true;
  };
  assert.equal(await copyText('第一行\n第二行', { document, navigator: {} }), true);
  assert.deepEqual(seen, {
    command: 'copy', tag: 'TEXTAREA', readonly: true, selected: '第一行\n第二行', fontSize: '16px',
  }, '只读（手机不弹键盘）、16px（iPhone 不放大页面），整段选中');
  assert.equal(document.querySelector('textarea'), null, '临时文本框用完就删');
  assert.equal(document.activeElement, button, '焦点放回原来的按钮');
});

test('剪贴板接口被拒时再试老办法；两样都不行返回 false，也不留下临时文本框', async t => {
  const document = page(t);
  const denied = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
  let legacy = 0;
  document.execCommand = () => { legacy += 1; return true; };
  assert.equal(await copyText('x', { document, navigator: denied }), true);
  assert.equal(legacy, 1);

  document.execCommand = () => false;
  assert.equal(await copyText('x', { document, navigator: denied }), false);
  document.execCommand = () => { throw new Error('boom'); };
  assert.equal(await copyText('x', { document, navigator: {} }), false);
  delete document.execCommand;
  assert.equal(await copyText('x', { document, navigator: {} }), false, '浏览器连老办法都没有');
  assert.equal(document.querySelector('textarea'), null);
});

test('「一键复制」按钮：成功显示「✓ 已复制」，过一会儿变回来；失败提示长按手动复制', async t => {
  const document = page(t);
  const written = [];
  const row = createCopyRow('a cat', { document, navigator: { clipboard: { writeText: async text => { written.push(text); } } } });
  document.body.append(row);
  const button = row.querySelector('button');
  assert.equal(row.className, 'stia-copy-row');
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, '一键复制');

  button.click();
  await settle();
  assert.deepEqual(written, ['a cat']);
  assert.equal(button.textContent, '✓ 已复制');
  assert.equal(button.classList.contains('is-copied'), true);
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(button.textContent, '一键复制');
  assert.equal(button.classList.contains('is-copied'), false);

  const failing = createCopyRow('a cat', { document, navigator: {} }).querySelector('button');
  failing.click();
  await settle();
  assert.equal(failing.textContent, '复制失败，请长按文字复制');
  assert.equal(failing.classList.contains('is-failed'), true);
});
