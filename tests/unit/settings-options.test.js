import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_SIZE_OPTIONS } from '../../src/ui/pages/settings/settings.js';

test('常用尺寸选项包含 512x768，且使用接口兼容格式', () => {
  const values = IMAGE_SIZE_OPTIONS.map(([value]) => value);
  assert.equal(values.length, new Set(values).size);
  assert.ok(values.includes('512x768'));
  assert.ok(values.includes('768x512'));
  assert.ok(values.includes('576x1024'));
  assert.ok(values.includes('1024x576'));
  assert.ok(values.includes('2400x3200'), '超大竖图');
  assert.ok(values.includes('3200x2400'), '超大横图配对');
  assert.ok(values.length >= 20);
  for (const value of values.filter(item => item !== 'auto')) {
    assert.match(value, /^\d+x\d+$/);
  }
});

test('质量下拉包含 gpt-image-2.5 的 xhigh / max，且按档位从低到高排列', async () => {
  const { IMAGE_QUALITY_OPTIONS } = await import('../../src/ui/pages/settings/settings.js');
  const values = IMAGE_QUALITY_OPTIONS.map(([value]) => value);
  assert.equal(values.length, new Set(values).size);
  assert.equal(values[0], 'auto');
  const ladder = ['low', 'medium', 'high', 'xhigh', 'max'].map(value => values.indexOf(value));
  assert.ok(ladder.every(index => index >= 0), '五档都在');
  assert.deepEqual([...ladder].sort((left, right) => left - right), ladder, '低 → 高');
  assert.ok(values.includes('standard') && values.includes('hd'), 'dall-e-3 的选项保留');
  assert.ok(!values.includes(''), '质量列表本身不含空值，空值只由下拉层加入');
  for (const value of ['xhigh', 'max']) {
    const [, label] = IMAGE_QUALITY_OPTIONS.find(([item]) => item === value);
    assert.match(label, /2\.5/, `${value} 标注仅 2.5 系列支持`);
  }
});

test('生图参数下拉自带「不发送」选项，值为空串以便直接映射 sendSize / sendQuality / sendN', async () => {
  const { SKIP_PARAM_OPTION } = await import('../../src/ui/pages/settings/settings.js');
  assert.equal(SKIP_PARAM_OPTION[0], '');
  assert.ok(/不发送/.test(SKIP_PARAM_OPTION[1]));
  assert.ok(!IMAGE_SIZE_OPTIONS.some(([value]) => value === ''), '尺寸列表本身不含空值，空值只由下拉层加入');
});
