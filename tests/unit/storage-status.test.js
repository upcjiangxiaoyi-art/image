/* 2.4.0 设置页「数据文件」：画廊索引、生成记录是拆开存的还是整份存的，拆分没成功时写出原因。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStorage } from '../../src/ui/pages/settings/storage-status.js';

test('拆好了：各一行，写明几份、多少条', () => {
  assert.deepEqual(describeStorage({
    gallery: { mode: 'segmented', segments: 82, records: 1012, migrating: false, error: '' },
    attempts: { mode: 'segmented', segments: 24, records: 1873, migrating: false, error: '' },
  }), [
    '画廊索引：已拆成 82 份小文件，共 1012 张图的记录',
    '生成记录：已拆成 24 份小文件，共 1873 条',
  ]);
});

test('正在拆、没拆成、后台写入出过错：都说清楚现在怎么样、照不照常能用', () => {
  const [migrating] = describeStorage({ gallery: { mode: 'legacy', segments: 0, records: 1012, migrating: true, error: '' } });
  assert.equal(migrating, '画廊索引：还是一整份文件，正在后台拆成小文件（共 1012 张图的记录），拆完之前照旧能用');

  const [failed] = describeStorage({ gallery: { mode: 'legacy', segments: 3, records: 1012, migrating: false, error: '写入画廊元数据失败（HTTP 413）' } });
  assert.equal(failed, '画廊索引：还是一整份文件，拆分没成功（写入画廊元数据失败（HTTP 413））。照旧能用，过一会儿或下次打开页面再试');

  const [waiting] = describeStorage({ attempts: { mode: 'legacy', segments: 0, records: 5, migrating: false, error: '' } });
  assert.equal(waiting, '生成记录：还是一整份文件（共 5 条），等着拆分');

  const [hiccup] = describeStorage({ gallery: { mode: 'segmented', segments: 2, records: 9, migrating: false, error: 'HTTP 502' } });
  assert.equal(hiccup, '画廊索引：已拆成 2 份小文件，共 9 张图的记录；最近一次后台写入没成功（HTTP 502），下次写入时再试');
});

test('内存版的存储、还没读进来：不显示', () => {
  assert.deepEqual(describeStorage({ gallery: null, attempts: null }), []);
  assert.deepEqual(describeStorage(), []);
  assert.deepEqual(describeStorage({ gallery: { mode: 'unloaded', segments: 0, records: 0 } }), []);
});
