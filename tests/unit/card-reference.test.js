import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCard } from '../../src/ui/renderer/card.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function setup({ settings = { executionMode: 'direct', generationProvider: 'openai' }, provider = 'openai', presets = [{ id: 'p1', name: '主站', active: true }] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  const calls = [];
  const state = {
    tag: { latestResultId: 'r1', resultIds: ['r1'] },
    attempts: [{ attemptId: 'a1', status: 'succeeded', provider, presetId: 'p1', createdAt: '2026-11-05T00:00:00.000Z', completedAt: '2026-11-05T00:00:30.000Z', resultIds: ['r1'] }],
    results: [{ resultId: 'r1', status: 'available', provider, presetId: 'p1', prompt: 'cat', references: ['user/images/st-image-atelier-refs/ref-1.png'] }],
  };
  const card = createCard({
    tag: { tagId: 'tag-1', prompt: 'cat' },
    api: { fileUrl: () => '/user/images/st-image-atelier/r1.png', uploadReferenceImage: async () => ({ path: 'user/images/st-image-atelier-refs/ref-temp.png' }) },
    getState: () => state,
    getSettings: () => settings,
    onGenerate: () => {},
    onOpenGallery: () => {},
    onCancel: () => {},
    onReroll: () => {},
    onReferenceRegenerate: (tag, options) => { calls.push({ tag, options }); },
    listPresets: async () => presets,
  });
  dom.window.document.body.append(card.root);
  card.render();
  const buttons = () => [...card.root.querySelectorAll('button')];
  const find = label => buttons().find(button => button.textContent.includes(label));
  return { card, calls, buttons, find, dom };
}

test('出图后的卡片有「参考重画」：默认拿这张图当参考，只有一个预设时确认一下就画', async t => {
  const { card, calls, find, dom } = setup();
  t.after(() => dom.window.close());
  assert.ok(find('参考重画'), '按钮在');
  assert.match(card.root.textContent, /参考图.*带了 1 张/, '信息里写着这张图带了几张参考');
  find('参考重画').click();
  await tick();
  assert.match(card.root.textContent, /用卡片上这张图当参考重画/);
  assert.ok(find('从相册另选一张'));
  find('确定参考重画').click();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.references, [{ resultId: 'r1' }]);
  assert.equal(calls[0].options.preset.id, 'p1');
  assert.equal(find('确定参考重画'), undefined, '选完收起');
});

test('有几个预设时先选预设，「原渠道」排第一；「算了」收起', async t => {
  const { calls, find, dom } = setup({ presets: [{ id: 'p2', name: '备用', active: false }, { id: 'p1', name: '主站', active: true }] });
  t.after(() => dom.window.close());
  find('参考重画').click();
  await tick();
  const options = [...dom.window.document.querySelectorAll('.stia-card__reroll-preset')].map(button => button.textContent);
  assert.deepEqual(options, ['主站（原渠道）', '备用']);
  find('算了').click();
  assert.equal(calls.length, 0);
  assert.equal(find('确定参考重画'), undefined);
  find('参考重画').click();
  await tick();
  find('备用').click();
  assert.equal(calls[0].options.preset.id, 'p2');
  assert.deepEqual(calls[0].options.references, [{ resultId: 'r1' }]);
});

test('NovelAI 和增强模式没有「参考重画」', t => {
  const nai = setup({ settings: { executionMode: 'direct', generationProvider: 'novelai' }, provider: 'novelai' });
  t.after(() => nai.dom.window.close());
  assert.equal(nai.find('参考重画'), undefined);
  const server = setup({ settings: { executionMode: 'server', generationProvider: 'openai' } });
  t.after(() => server.dom.window.close());
  assert.equal(server.find('参考重画'), undefined);
});
