/* 2.4.0 酒馆用户文件的读写层：带着本机缓存的 ETag 去读、写、删、看文件头。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTavernFiles } from '../../src/ui/api/tavern-files.js';
import { createMemorySegmentCache } from '../../src/ui/api/segment-cache.js';
import { compat, createFileServer } from '../helpers/file-server.js';

test('读：有就给正文和 ETag，没有是 404，别的状态抛错（带上是读什么失败的）', async () => {
  const server = createFileServer();
  server.put('a.json', '{"a":1}');
  const files = createTavernFiles(compat, server.fetch, { label: '画廊元数据' });
  const found = await files.read('a.json');
  assert.equal(found.status, 200);
  assert.equal(found.text, '{"a":1}');
  assert.match(found.etag, /^W\/"7-[0-9a-f]+"$/);
  assert.deepEqual(await files.read('missing.json'), { status: 404 });
  server.failRead = () => true;
  await assert.rejects(files.read('a.json'), error => error.code === 'LOCAL_SAVE_FAILED'
    && error.status === 500 && /读取画廊元数据失败（HTTP 500）/.test(error.details));
});

test('带缓存读：记住之后没变就回 304、用缓存里的正文；变了重新下载；没 remember 过的不进缓存；文件没了缓存也清掉', async () => {
  const server = createFileServer();
  const cache = createMemorySegmentCache();
  const files = createTavernFiles(compat, server.fetch, { cache });
  server.put('seg.json', '{"v":1}');

  const first = await files.read('seg.json', { cached: true });
  assert.equal(first.cached, undefined);
  assert.equal(cache.entries.size, 0, '读到了不等于记住：等调用方确认内容能用');
  files.remember('seg.json', first);
  assert.equal(cache.entries.size, 1);

  server.resetLogs();
  const second = await files.read('seg.json', { cached: true });
  assert.deepEqual(second, { status: 200, text: '{"v":1}', etag: first.etag, cached: true });
  assert.deepEqual(server.reads.map(read => [read.status, read.bytes]), [[304, 0]]);

  server.put('seg.json', '{"v":22}');
  const third = await files.read('seg.json', { cached: true });
  assert.equal(third.text, '{"v":22}');
  assert.equal(third.cached, undefined);
  assert.equal(cache.entries.get('seg.json').text, '{"v":1}', '新的一份还没 remember');

  server.resetLogs();
  await files.read('seg.json');
  assert.deepEqual(server.reads.map(read => read.status), [200], '不带 cached 就不用缓存（清单、旧文件每次都重新读）');

  server.files.delete('seg.json');
  assert.deepEqual(await files.read('seg.json', { cached: true }), { status: 404 });
  await null;
  assert.equal(cache.entries.size, 0);

  files.remember('x.json', { etag: '', text: '{}' });
  assert.equal(cache.entries.size, 0, '服务器没给 ETag 的不缓存');
});

test('写：返回写上去的字节数；和上一版一样大就多垫一个空格；失败抛错', async () => {
  const server = createFileServer();
  const files = createTavernFiles(compat, server.fetch, { label: '生成记录' });
  assert.equal(await files.write('a.json', '{"名":"值"}'), 13, '中文按 UTF-8 算字节');
  assert.equal(server.files.get('a.json'), '{"名":"值"}');
  assert.equal(await files.write('a.json', '{"名":"换"}', { avoidSize: 13 }), 14);
  assert.equal(server.files.get('a.json'), '{"名":"换"} ');
  assert.deepEqual(JSON.parse(server.files.get('a.json')), { 名: '换' });
  assert.equal(await files.write('a.json', '{"名":"换"}', { avoidSize: 14 }), 13, '不一样大就不垫');

  server.failUpload = () => true;
  await assert.rejects(files.write('a.json', '{}'), error => error.code === 'LOCAL_SAVE_FAILED'
    && /写入生成记录失败（HTTP 500）/.test(error.details));
  server.failUpload = null;
  await assert.rejects(files.write('中文名.json', '{}'), error => error.status === 400, '酒馆不收的文件名');
});

test('删、看文件头：删掉了返回 true，接口不在或文件不在返回 false，都不抛错；文件头问不到返回 null', async () => {
  const server = createFileServer();
  const cache = createMemorySegmentCache([['a.json', { etag: 'W/"1-1"', text: '{}' }]]);
  const files = createTavernFiles(compat, server.fetch, { cache });
  server.put('a.json', '{}');
  const head = await files.head('a.json');
  assert.equal(head.status, 200);
  assert.match(head.etag, /^W\/"2-[0-9a-f]+"$/);
  assert.deepEqual(await files.head('nope.json'), { status: 404, etag: '' });
  assert.equal(await files.remove('a.json'), true);
  assert.equal(server.files.has('a.json'), false);
  assert.equal(cache.entries.size, 0, '缓存一起清');
  assert.equal(await files.remove('a.json'), false);
  server.deleteSupported = false;
  assert.equal(await files.remove('b.json'), false);

  const offline = createTavernFiles(compat, async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(await offline.head('a.json'), null);
  assert.equal(await offline.remove('a.json'), false);
});

test('forget：缓存里这个前缀下、不在清单上的都清掉，别的前缀不动', async () => {
  const cache = createMemorySegmentCache([
    ['gallery-m0001.json', { etag: 'e1', text: '{}' }],
    ['gallery-m0002.json', { etag: 'e2', text: '{}' }],
    ['attempts-m0001.json', { etag: 'e3', text: '{}' }],
  ]);
  const files = createTavernFiles(compat, async () => new Response(''), { cache });
  files.forget('gallery-', new Set(['gallery-m0002.json']));
  await null;
  assert.deepEqual([...cache.entries.keys()], ['gallery-m0002.json', 'attempts-m0001.json']);
  createTavernFiles(compat, async () => new Response('')).forget('gallery-', new Set());
});
