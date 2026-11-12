/* 2.4.0 画廊索引、生成记录拆成「一份清单 + 若干小文件（分片）」。
   这里用真的画廊存储 + 真的酒馆文件读写层，对着一个只有用户文件接口的假酒馆跑。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_INDEX_FILE as INDEX,
  GALLERY_METADATA_FILE as LEGACY,
  GALLERY_SEGMENT_PREFIX as PREFIX,
  createMemoryGalleryMetadataStore,
  createSillyTavernGalleryMetadataStore,
} from '../../src/ui/api/gallery-metadata-store.js';
import {
  ATTEMPT_INDEX_FILE,
  ATTEMPT_SEGMENT_PREFIX,
  ATTEMPT_STORE_FILE,
  createSillyTavernAttemptStore,
} from '../../src/ui/api/attempt-store.js';
import { createMemorySegmentCache } from '../../src/ui/api/segment-cache.js';
import { bytesFromEtag, runPool } from '../../src/ui/api/segmented-backend.js';
import { compat, createFileServer } from '../helpers/file-server.js';

const T0 = Date.parse('2026-11-12T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const seg = id => `${PREFIX}${id}.json`;
const migrated = count => Array.from({ length: count }, (_, index) => `m${String(index + 1).padStart(4, '0')}`);

/* at：第几秒画的（T0 的前一天起算）。 */
function record(id, { at = 0, ...extra } = {}) {
  return {
    resultId: id,
    tagId: `tag-${id}`,
    messageUuid: `msg-${id}`,
    chatId: '钟由时 - 聊天',
    prompt: `comic page, ${id}, `.padEnd(240, 'detail '),
    status: 'available',
    createdAt: new Date(T0 - DAY + at * 1000).toISOString(),
    localRelativePath: `user/images/st-image-atelier/${id}.png`,
    ...extra,
  };
}

/* 开一次页面：一个新的画廊存储对着同一个酒馆。 */
function session(server, { clock, cache = null, records = 150, bytes = 160_000, flushDelayMs = 0, warnings = [], retryDelaysMs = [] } = {}) {
  return createSillyTavernGalleryMetadataStore(compat, server.fetch, {
    flushDelayMs,
    cache,
    segmentRecords: records,
    segmentBytes: bytes,
    backend: {
      now: () => clock.now,
      newSegmentId: () => {
        server.segmentCounter = (server.segmentCounter || 0) + 1;
        return `s${server.segmentCounter}`;
      },
      warn: (...args) => warnings.push(args),
      retryDelaysMs,
    },
  });
}

/* 等这次改动写完，后台的活（改清单、看别人加的记录）也做完。 */
async function settle(store) {
  await store.flush();
  await store.storage.whenIdle();
}

/* 2.3.0 写出来的整份文件。 */
async function writeLegacy(server, items) {
  const memory = createMemoryGalleryMetadataStore();
  await memory.initialize();
  await memory.putMany(items);
  await memory.flush();
  server.put(LEGACY, JSON.stringify(memory.document));
  return server.files.get(LEGACY);
}

/* 顺着清单能找到的所有记录。 */
function reachable(server) {
  const out = {};
  for (const id of server.json(INDEX).segments) {
    if (server.files.has(seg(id))) Object.assign(out, server.json(seg(id)).results);
  }
  return out;
}

const ids = store => store.values().map(item => item.resultId).sort();
const byId = store => Object.fromEntries(store.values().map(item => [item.resultId, item]));
const names = entries => entries.map(item => item.name);
/* DirectError 的 message 是一句笼统的「图片保存到酒馆失败」，具体原因在 details 里。 */
const detailed = pattern => error => {
  assert.match(String(error.details), pattern);
  return true;
};

test('全新安装：打开页面只写一份清单（先登记好第一个分片）；出一张图只上传那一个分片；再打开什么都不写', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const store = session(server, { clock });
  await store.initialize();
  assert.deepEqual(store.values(), []);
  await store.storage.whenIdle();
  assert.deepEqual(names(server.uploads), [INDEX]);
  assert.deepEqual(server.json(INDEX), { schemaVersion: 1, segments: ['s1'] });
  assert.deepEqual(store.storage.status(), { mode: 'segmented', segments: 0, records: 0, migrating: false, error: '' });

  server.resetLogs();
  await store.putMany([record('r1')]);
  await settle(store);
  assert.deepEqual(names(server.uploads), [seg('s1')], '只上传一个分片，清单不用动');
  assert.deepEqual(Object.keys(reachable(server)), ['r1']);
  assert.equal(server.files.has(LEGACY), false, '不再有整份的文件');
  assert.equal(store.storage.status().segments, 1);

  server.resetLogs();
  const again = session(server, { clock });
  await again.initialize();
  assert.deepEqual(ids(again), ['r1']);
  await again.storage.whenIdle();
  assert.deepEqual(server.uploads, [], '重新打开页面不写任何文件');
  assert.deepEqual(server.deletes, []);
});

test('旧的整份文件：打开就能用，后台把分片传完才写清单；旧文件一个字节不动，记录一条不少，每个分片都不超上限', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const items = Array.from({ length: 300 }, (_, index) => record(`r${String(index).padStart(3, '0')}`, { at: index }));
  const original = await writeLegacy(server, items);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  server.uploadGate = () => gate;

  const store = session(server, { clock, bytes: 20_000 });
  await store.initialize();
  assert.equal(store.values().length, 300, '还没拆完也照常能用');
  assert.equal(store.storage.status().mode, 'legacy');
  assert.equal(server.files.has(INDEX), false);

  server.uploadGate = null;
  release();
  await store.storage.whenIdle();
  assert.equal(store.storage.status().mode, 'segmented');
  const uploaded = names(server.uploads);
  assert.equal(uploaded.indexOf(INDEX), uploaded.length - 1, '清单最后才写，而且只写一次');
  const manifest = server.json(INDEX);
  const count = uploaded.length - 1;
  assert.ok(count >= 8, `拆成了 ${count} 份`);
  assert.deepEqual(manifest.segments, [...migrated(count), 's1'], '分片名是固定的 m0001、m0002…，按时间排；最后登记一个新的给以后的图用');
  assert.deepEqual([...uploaded.slice(0, -1)].sort(), migrated(count).map(seg));
  assert.equal(manifest.legacy.file, LEGACY);
  assert.equal(manifest.legacy.importedAt, new Date(T0).toISOString());
  assert.ok(manifest.legacy.etag, '记下旧文件拆分时的样子');
  assert.equal(server.files.get(LEGACY), original, '旧文件原样留着当备份');
  assert.deepEqual(reachable(server), byId(store), '记录一条不少、内容一样');
  assert.equal(Object.keys(server.json(seg('m0001')).results)[0], 'r000', '最早的在第一份里');
  for (const upload of server.uploads.slice(0, -1)) {
    assert.ok(upload.bytes <= 20_000 + 700, `${upload.name} 有 ${upload.bytes} 字节`);
  }

  server.resetLogs();
  const again = session(server, { clock, bytes: 20_000 });
  await again.initialize();
  await again.storage.whenIdle();
  assert.deepEqual(byId(again), byId(store));
  assert.deepEqual(server.uploads, [], '拆完以后重新打开不再写');
  assert.equal(server.reads.some(read => read.name === LEGACY && read.method === 'GET'), false, '旧文件不再下载');
});

test('上限按字节算：中文提示词一个字三个字节，分片照样不超上限', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const prompt = '漫画分镜，雨夜的码头，镜头从高处俯拍。'.repeat(40);
  await writeLegacy(server, Array.from({ length: 80 }, (_, index) => record(`r${index}`, { at: index, prompt })));
  const store = session(server, { clock, bytes: 20_000 });
  await store.initialize();
  await store.storage.whenIdle();
  const segments = server.uploads.filter(upload => upload.name !== INDEX);
  const one = Buffer.byteLength(JSON.stringify(store.get('r0')));
  assert.ok(one > 2_000, `一条记录 ${one} 字节（${JSON.stringify(store.get('r0')).length} 个字符）`);
  assert.ok(segments.length >= 9, `拆成了 ${segments.length} 份`);
  for (const upload of segments) {
    assert.ok(upload.bytes <= 20_000 + one, `${upload.name} 有 ${upload.bytes} 字节`);
  }
  assert.deepEqual(reachable(server), byId(store));

  server.resetLogs();
  await store.putMany([record('fresh', { at: 9000, prompt })]);
  await settle(store);
  const written = server.uploads.filter(upload => upload.name !== INDEX);
  assert.equal(written.length, 1);
  assert.ok(written[0].bytes <= 20_000 + one, `新图所在的那份 ${written[0].bytes} 字节`);
});

test('拆到一半失败：照旧按整份文件工作，新出的图不丢；下次打开从头再来，分片名不变，最后一条不少', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 60 }, (_, index) => record(`r${index}`, { at: index })));
  const warnings = [];
  server.failUpload = name => name === seg('m0003');

  const store = session(server, { clock, bytes: 5_000, warnings });
  await store.initialize();
  await store.storage.whenIdle();
  assert.equal(store.storage.status().mode, 'legacy');
  assert.match(store.storage.status().error, /HTTP 500/, '设置页能看到为什么没拆成');
  assert.equal(warnings.length, 1);
  assert.equal(server.files.has(INDEX), false, '没传完不写清单');
  assert.ok(server.issued.length <= 6, '一出错就停，不会把剩下的全传一遍');

  await store.putMany([record('fresh', { at: 5000 })]);
  await settle(store);
  assert.equal(Object.keys(server.json(LEGACY).results).length, 61, '新记录照旧写进整份文件');
  assert.equal(server.files.has(INDEX), false);

  /* 页面关了，下次打开（这次服务器好了）。 */
  server.failUpload = null;
  const next = session(server, { clock, bytes: 5_000 });
  await next.initialize();
  assert.equal(next.values().length, 61);
  await next.storage.whenIdle();
  assert.equal(next.storage.status().mode, 'segmented');
  assert.deepEqual(reachable(server), byId(next));
  const listed = server.json(INDEX).segments;
  assert.ok(listed.slice(0, -1).every(id => /^m\d{4}$/.test(id)), '还是那套固定的名字，覆盖着写');
  assert.equal(server.names(PREFIX).length, listed.length, '没有留下用不上的文件（清单一份，最后登记的那个分片还没有文件）');
});

test('拆到一半页面关了，下次打开从头再来：上次已经传上去、内容一样的分片读回来比一遍就跳过，只传剩下的', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 60 }, (_, index) => record(`r${index}`, { at: index })));
  /* 第一次：传到第 5 份就断了。 */
  server.failUpload = name => name === seg('m0005');
  const first = session(server, { clock, bytes: 5_000 });
  await first.initialize();
  await first.storage.whenIdle();
  const done = server.names(PREFIX);
  assert.ok(done.length >= 4 && done.length <= 6, `第一次传上去了 ${done.length} 份`);
  server.failUpload = null;
  /* 这期间又出了一张图（照旧写进整份文件）。 */
  await first.putMany([record('fresh', { at: 9000 })]);
  await settle(first);

  server.resetLogs();
  const second = session(server, { clock, bytes: 5_000 });
  await second.initialize();
  await second.storage.whenIdle();
  assert.equal(second.storage.status().mode, 'segmented');
  const uploaded = names(server.uploads);
  assert.equal(server.verifies.length, 1, '一次请求问完哪些文件已经在了');
  assert.deepEqual(uploaded.filter(name => done.includes(name)), [], '上次传好、内容没变的都没重传');
  assert.ok(uploaded.includes(seg('m0005')), '上次没传上去的这次传了');
  const listed = server.json(INDEX).segments.filter(id => /^m/.test(id)).length;
  assert.equal(uploaded.filter(name => name !== INDEX).length, listed - done.length);
  assert.deepEqual(reachable(server), byId(second));
  assert.equal(second.values().length, 61);

  /* 读回来不一样的（内容变过）照样重传：比的是内容，不是有没有这个文件。 */
  const third = createFileServer();
  await writeLegacy(third, Array.from({ length: 20 }, (_, index) => record(`r${index}`, { at: index })));
  third.put(seg('m0001'), '{"schemaVersion":1,"results":{}}');
  const store = session(third, { clock, bytes: 5_000 });
  await store.initialize();
  await store.storage.whenIdle();
  assert.ok(names(third.uploads).includes(seg('m0001')));
  assert.deepEqual(reachable(third), byId(store));
});

test('酒馆没有 /api/files/verify（老版本）：拆分重来就老老实实全部重传', async () => {
  const server = createFileServer();
  server.verifySupported = false;
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 30 }, (_, index) => record(`r${index}`, { at: index })));
  server.failUpload = name => name === seg('m0003');
  const first = session(server, { clock, bytes: 5_000 });
  await first.initialize();
  await first.storage.whenIdle();
  server.failUpload = null;
  server.resetLogs();
  const second = session(server, { clock, bytes: 5_000 });
  await second.initialize();
  await second.storage.whenIdle();
  assert.equal(second.storage.status().mode, 'segmented');
  assert.equal(names(server.uploads).filter(name => name !== INDEX).length, server.json(INDEX).segments.length - 1);
  assert.deepEqual(reachable(server), byId(second));
});

test('拆分失败后不用等刷新：过一分钟、下一次有东西要写时接着拆（传过的不重传）', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 40 }, (_, index) => record(`r${index}`, { at: index })));
  server.failUpload = name => name === seg('m0002');
  const store = session(server, { clock, bytes: 5_000 });
  await store.initialize();
  await store.storage.whenIdle();
  assert.equal(store.storage.status().mode, 'legacy');
  server.failUpload = null;

  await store.putMany([record('a', { at: 5000 })]);
  await settle(store);
  assert.equal(store.storage.status().mode, 'legacy', '刚失败过，先不急着重试');

  clock.now += 61_000;
  server.resetLogs();
  await store.putMany([record('b', { at: 5001 })]);
  await settle(store);
  assert.equal(store.storage.status().mode, 'segmented');
  assert.equal(store.storage.status().error, '');
  assert.equal(names(server.uploads).includes(seg('m0001')), false, '上次传好的那份不重传');
  assert.deepEqual(reachable(server), byId(store));
  assert.equal(store.values().length, 42);
});

test('拆完以后出一张图只上传一个分片，大小不超上限，和总共存了多少无关；整份文件不再写，清单只在换分片时写', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 300 }, (_, index) => record(`r${index}`, { at: index })));
  const store = session(server, { clock, bytes: 20_000 });
  await store.initialize();
  await store.storage.whenIdle();
  const legacyBytes = Buffer.byteLength(server.files.get(LEGACY));
  assert.ok(legacyBytes > 150_000, `整份有 ${legacyBytes} 字节`);

  /* 连着出一百张图：尾巴分片从空到满、换了好几个。 */
  let manifestWrites = 0;
  for (let index = 0; index < 100; index += 1) {
    server.resetLogs();
    await store.putMany([record(`fresh${index}`, { at: 9000 + index })]);
    await settle(store);
    const segments = server.uploads.filter(upload => upload.name !== INDEX);
    manifestWrites += server.uploads.length - segments.length;
    assert.equal(segments.length, 1, `第 ${index + 1} 张只上传一个分片`);
    assert.match(segments[0].name, /^st-image-atelier-gallery-s\d+\.json$/, '新图不往拆出来的 m 分片里加');
    assert.ok(segments[0].bytes <= 20_000 + 700, `这一份 ${segments[0].bytes} 字节`);
    assert.equal(names(server.uploads).includes(LEGACY), false);
  }
  assert.ok(manifestWrites >= 2 && manifestWrites <= 4, `一百张图清单只写了 ${manifestWrites} 次`);
  assert.equal(Object.keys(reachable(server)).length, 400);

  server.resetLogs();
  await store.update('fresh99', { thumbnailPath: 'user/images/st-image-atelier/thumbs/fresh99.jpg' });
  await settle(store);
  assert.equal(server.uploads.length, 1, '补缩略图路径也只重写那一份');
  assert.equal(reachable(server).fresh99.thumbnailPath, 'user/images/st-image-atelier/thumbs/fresh99.jpg');
});

test('尾巴分片满了：先在清单上登记下一个，登记好之前新记录还放在原来那个里——任何时候都没有记录落在清单以外', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const store = session(server, { clock, records: 3 });
  await store.initialize();
  await store.storage.whenIdle();
  const expected = [];
  const add = async id => {
    await store.putMany([record(id)]);
    expected.push(id);
    await store.flush();
    assert.deepEqual(Object.keys(reachable(server)).sort(), [...expected].sort(), `加了 ${id} 之后顺着清单都找得到`);
  };
  await add('a');
  await add('b');
  await add('c');
  await store.storage.whenIdle();
  assert.deepEqual(server.json(INDEX).segments, ['s1'], '刚好装满还不用开新的');

  /* 清单写得慢：登记还在路上，又来了两张图。 */
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  server.uploadGate = name => (name === INDEX ? gate : null);
  await add('d');
  await add('e');
  assert.deepEqual(Object.keys(server.json(seg('s1')).results), ['a', 'b', 'c', 'd', 'e'], '登记好之前都放在原来那个里');
  assert.deepEqual(server.json(INDEX).segments, ['s1']);

  server.uploadGate = null;
  release();
  await store.storage.whenIdle();
  assert.deepEqual(server.json(INDEX).segments, ['s1', 's2'], '登记好了');
  await add('f');
  assert.deepEqual(Object.keys(server.json(seg('s2')).results), ['f'], '之后的进新分片');
  assert.deepEqual(Object.keys(server.json(seg('s1')).results), ['a', 'b', 'c', 'd', 'e'], '旧的那个不再动');
  await store.storage.whenIdle();
  assert.equal(server.uploads.filter(item => item.name === INDEX).length, 2, '清单总共只写了两次：建的时候、登记的时候');
});

test('改一条、删一条只重写它所在的分片；整个分片删空了就从清单上摘掉、文件删掉；尾巴空了也留着', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 6 }, (_, index) => record(`r${index}`, { at: index })));
  const store = session(server, { clock, records: 2 });
  await store.initialize();
  await store.storage.whenIdle();
  assert.deepEqual(server.json(INDEX).segments, ['m0001', 'm0002', 'm0003', 's1'], '最后一份是满的，顺手登记好下一个');

  server.resetLogs();
  await store.update('r2', { favorite: true });
  await settle(store);
  assert.deepEqual(names(server.uploads), [seg('m0002')]);

  server.resetLogs();
  await store.removeMany(['r0', 'r1']);
  await settle(store);
  assert.deepEqual(names(server.uploads), [seg('m0001'), INDEX], '先把空的那版写上去，再改清单');
  assert.deepEqual(server.uploads[0].text, '{"schemaVersion":1,"results":{}}');
  assert.deepEqual(server.json(INDEX).segments, ['m0002', 'm0003', 's1']);
  assert.deepEqual(server.deletes, [seg('m0001')]);
  assert.equal(server.files.has(seg('m0001')), false);

  await store.putMany([record('x', { at: 100 })]);
  await settle(store);
  await store.remove('x');
  await settle(store);
  assert.deepEqual(server.json(INDEX).segments, ['m0002', 'm0003', 's1'], '尾巴空了也留着，下一张图还往里放');
  assert.deepEqual(server.json(seg('s1')).results, {});

  const again = session(server, { clock, records: 2 });
  await again.initialize();
  assert.deepEqual(ids(again), ['r2', 'r3', 'r4', 'r5']);
  assert.equal(again.get('r2').favorite, true);
});

test('酒馆没有删除文件的接口（老版本）：空分片照样从清单上摘掉，只是文件留在那儿', async () => {
  const server = createFileServer();
  server.deleteSupported = false;
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 4 }, (_, index) => record(`r${index}`, { at: index })));
  const store = session(server, { clock, records: 2 });
  await store.initialize();
  await store.storage.whenIdle();
  await store.removeMany(['r0', 'r1']);
  await settle(store);
  assert.deepEqual(server.json(INDEX).segments, ['m0002', 's1']);
  assert.equal(server.files.has(seg('m0001')), true);
  assert.equal(store.storage.status().error, '');
  const again = session(server, { clock, records: 2 });
  await again.initialize();
  assert.deepEqual(ids(again), ['r2', 'r3']);
});

test('改清单是「服务器上现在的清单，加减我自己的」：别的设备新开的分片不会被开了很久的页面挤掉', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const store = session(server, { clock, records: 1 });
  await store.initialize();
  await store.storage.whenIdle();
  await store.putMany([record('a')]);
  await settle(store);

  /* 另一台设备：登记了自己的分片，往里放了一张图。 */
  const other = await session(createFileServer(), { clock }).initialize();
  await other.putMany([record('z')]);
  server.put(seg('other'), { schemaVersion: 1, results: { z: other.get('z') } });
  server.put(INDEX, { schemaVersion: 1, segments: ['s1', 'other'] });

  await store.putMany([record('b')]);
  await settle(store);
  assert.deepEqual(server.json(INDEX).segments, ['s1', 'other', 's2'], '我登记新分片时，别人的那个还在');
  await store.putMany([record('c')]);
  await settle(store);
  assert.deepEqual(Object.keys(server.json(seg('s2')).results), ['c']);

  const again = session(server, { clock, records: 1 });
  await again.initialize();
  assert.deepEqual(ids(again), ['a', 'b', 'c', 'z']);
});

test('开了很久的页面往分片里写之前先看一眼：别的设备加进去的记录原样带上，自己删掉的不会回来', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const store = session(server, { clock });
  await store.initialize();
  await store.storage.whenIdle();
  await store.putMany([record('a'), record('b')]);
  await settle(store);

  const appendElsewhere = id => {
    const file = server.json(seg('s1'));
    file.results[id] = { ...record(id), provider: 'openai', favorite: false };
    server.put(seg('s1'), file);
  };
  /* 不用等：哪怕刚写过这个分片，下一次写之前也会先看文件头，大小变了就知道有人动过。 */
  appendElsewhere('z');
  server.resetLogs();
  await store.putMany([record('c')]);
  await settle(store);
  assert.deepEqual(Object.keys(server.json(seg('s1')).results).sort(), ['a', 'b', 'c', 'z'], '别的设备加的 z 还在');
  assert.deepEqual(ids(store), ['a', 'b', 'c'], '这个页面自己的列表不变');
  assert.deepEqual(
    server.reads.filter(read => read.name === seg('s1')).map(read => read.method),
    ['HEAD', 'GET'],
    '先看文件头，大小不对才整份读回来',
  );

  server.resetLogs();
  await store.remove('a');
  await settle(store);
  assert.deepEqual(Object.keys(server.json(seg('s1')).results).sort(), ['b', 'c', 'z'], '删掉的 a 没有被当成别人的带回来');
  assert.deepEqual(
    server.reads.filter(read => read.name === seg('s1')).map(read => read.method),
    ['HEAD'],
    '没人动过：只看了一眼文件头，没有下载',
  );

  /* 写得比「看一眼」的回音还快（页面转入后台时会这样）：回音到了发现盖掉了别人的记录，补写一次。 */
  appendElsewhere('z2');
  clock.now += 60_000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  server.readGate = (name, method) => (name === seg('s1') && method === 'GET' ? gate : null);
  await store.putMany([record('d')]);
  await store.flush();
  assert.equal('z2' in server.json(seg('s1')).results, false, '这一下确实把 z2 盖掉了');
  server.readGate = null;
  release();
  await store.storage.whenIdle();
  assert.deepEqual(Object.keys(server.json(seg('s1')).results).sort(), ['b', 'c', 'd', 'z', 'z2'], '补回来了');

  const again = session(server, { clock });
  await again.initialize();
  assert.deepEqual(ids(again), ['b', 'c', 'd', 'z', 'z2']);
});

test('平常的写入等「看一眼」的回音回来再发：别的设备加的记录从头到尾没被盖掉过；切后台时的写入不等', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const store = session(server, { clock });
  await store.initialize();
  await store.storage.whenIdle();
  await store.putMany([record('a')]);
  await settle(store);

  const file = server.json(seg('s1'));
  file.results.z = { ...store.get('a'), resultId: 'z' };
  server.put(seg('s1'), file);
  /* 上面 settle() 里的 flush() 算一次「要转入后台了」，那之后两秒内的写入不等；这里过了那两秒。 */
  clock.now += 5_000;

  /* 「看一眼」的回音在路上慢了。 */
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  server.readGate = (name, method) => (name === seg('s1') && method === 'GET' ? gate : null);
  server.resetLogs();
  await store.putMany([record('b')]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(server.issued, [], '合并写的时间到了，但回音没回来，先不发');
  server.readGate = null;
  release();
  await settle(store);
  const written = server.uploads.filter(upload => upload.name === seg('s1'));
  assert.equal(written.length, 1, '只写了一次');
  assert.deepEqual(Object.keys(JSON.parse(written[0].text).results).sort(), ['a', 'b', 'z'], '写上去的那一版就带着 z');

  /* 回音一直不来：等到上限就先写，不会卡住。 */
  const quick = createSillyTavernGalleryMetadataStore(compat, server.fetch, {
    flushDelayMs: 0,
    cache: null,
    backend: { now: () => clock.now, warn: () => {}, refreshWaitMs: 20 },
  });
  await quick.initialize();
  const stuck = new Promise(() => {});
  server.readGate = (name, method) => (name === seg('s1') && method === 'HEAD' ? stuck : null);
  server.resetLogs();
  await quick.putMany([record('c')]);
  await quick.flush();
  clock.now += 5_000;
  server.resetLogs();
  await quick.putMany([record('d')]);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(server.issued, [seg('s1')], '等了 20 毫秒没等到，照常写了');
  server.readGate = null;
});

test('摘掉空分片之前先确认服务器上那份真的是空的：别的设备刚往里加了记录，就不摘、不删', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 4 }, (_, index) => record(`r${index}`, { at: index })));
  const store = session(server, { clock, records: 2 });
  await store.initialize();
  await store.storage.whenIdle();
  assert.deepEqual(server.json(INDEX).segments, ['m0001', 'm0002', 's1']);

  /* 清单读得慢：我把 m0001 删空、空的那版写上去了，还没来得及改清单。 */
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  server.readGate = name => (name === INDEX ? gate : null);
  await store.removeMany(['r0', 'r1']);
  await store.flush();
  assert.deepEqual(server.json(seg('m0001')).results, {});

  /* 这时别的设备（它手里的尾巴还是 m0001）往里加了一张。 */
  server.put(seg('m0001'), { schemaVersion: 1, results: { z: { ...store.get('r2'), resultId: 'z' } } });
  server.readGate = null;
  release();
  await store.storage.whenIdle();
  assert.deepEqual(server.json(INDEX).segments, ['m0001', 'm0002', 's1'], '没摘');
  assert.deepEqual(server.deletes, [], '没删');
  assert.ok(reachable(server).z);

  /* 之后我再动这个分片，z 也一直带着。 */
  const again = session(server, { clock, records: 2 });
  await again.initialize();
  assert.deepEqual(ids(again), ['r2', 'r3', 'z']);
});

test('开了很久的页面手里的尾巴分片已经被别的设备清空、摘掉了：往里写完会发现它不在清单上，补回去', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const stale = session(server, { clock, records: 3 });
  await stale.initialize();
  await stale.storage.whenIdle();
  await stale.putMany([record('r1')]);
  await settle(stale);

  const other = session(server, { clock, records: 3 });
  await other.initialize();
  await other.putMany([record('r2'), record('r3')]);
  await settle(other);
  await other.putMany([record('r4')]);
  await settle(other);
  await other.putMany([record('r5')]);
  await settle(other);
  await other.removeMany(['r1', 'r2', 'r3', 'r4']);
  await settle(other);
  assert.deepEqual(server.json(INDEX).segments, ['s2'], '那台设备把 s1 清空、摘掉了');
  assert.equal(server.files.has(seg('s1')), false);

  clock.now += 10 * 60_000;
  await stale.putMany([record('late')]);
  await settle(stale);
  assert.deepEqual(server.json(INDEX).segments, ['s2', 's1'], '补回清单');
  const found = reachable(server);
  assert.ok(found.late, '这张图找得到');
  assert.ok(found.r5);
});

test('分片带着本机缓存的 ETag 去问：没变的回 304、正文一个字节都不传；只有改过的那份重新下载；清单上没有了的缓存清掉', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const cache = createMemorySegmentCache();
  await writeLegacy(server, Array.from({ length: 6 }, (_, index) => record(`r${index}`, { at: index })));
  const first = session(server, { clock, cache, records: 2 });
  await first.initialize();
  await first.storage.whenIdle();
  const expected = byId(first);

  const segmentReads = () => server.reads.filter(read => read.name.startsWith(PREFIX) && read.name !== INDEX);
  server.resetLogs();
  const second = session(server, { clock, cache, records: 2 });
  await second.initialize();
  assert.deepEqual(segmentReads().map(read => read.status), [200, 200, 200, 404], '第一次每份都要下载（s1 还没有文件）');
  assert.deepEqual([...cache.entries.keys()].sort(), migrated(3).map(seg));

  server.resetLogs();
  const third = session(server, { clock, cache, records: 2 });
  await third.initialize();
  assert.deepEqual(segmentReads().map(read => read.status), [304, 304, 304, 404]);
  assert.equal(segmentReads().reduce((sum, read) => sum + read.bytes, 0), 0, '一个字节正文都没下载');
  assert.deepEqual(byId(third), expected, '缓存里的内容和服务器上的一样');
  assert.equal(server.reads.find(read => read.name === INDEX).status, 200, '清单每次都重新读');

  await third.update('r2', { favorite: true });
  await settle(third);
  server.resetLogs();
  const fourth = session(server, { clock, cache, records: 2 });
  await fourth.initialize();
  assert.deepEqual(
    Object.fromEntries(segmentReads().map(read => [read.name, read.status])),
    { [seg('m0001')]: 304, [seg('m0002')]: 200, [seg('m0003')]: 304, [seg('s1')]: 404 },
    '只有改过的那一份重新下载',
  );
  assert.equal(fourth.get('r2').favorite, true);

  /* 另一台设备（它有自己的缓存）把 m0001 删空、摘掉了。 */
  const elsewhere = session(server, { clock, cache: createMemorySegmentCache(), records: 2 });
  await elsewhere.initialize();
  await elsewhere.removeMany(['r0', 'r1']);
  await settle(elsewhere);
  const fifth = session(server, { clock, cache, records: 2 });
  await fifth.initialize();
  await fifth.storage.whenIdle();
  assert.deepEqual(ids(fifth), ['r2', 'r3', 'r4', 'r5']);
  assert.equal(cache.entries.has(seg('m0001')), false, '摘掉的分片，缓存也清了');
});

test('修改时间只精确到秒的文件系统：连着写的两版一样大时垫一个空格，ETag 才分得出新旧，不会读到缓存里的旧内容', async () => {
  const server = createFileServer({ coarseEtag: true });
  const clock = { now: T0 };
  const cache = createMemorySegmentCache();
  const first = session(server, { clock, cache });
  await first.initialize();
  await first.storage.whenIdle();
  await first.putMany([record('a', { tagId: 'aaaa' })]);
  await settle(first);

  const second = session(server, { clock, cache });
  await second.initialize();
  assert.equal(second.get('a').tagId, 'aaaa');
  await second.update('a', { tagId: 'bbbb' });
  await settle(second);
  const sizes = () => server.uploads.filter(item => item.name === seg('s1')).map(item => item.bytes);
  assert.equal(sizes().at(-1), sizes().at(-2) + 1, '内容一样长，文件多垫了一个字节');
  assert.equal(server.json(seg('s1')).results.a.tagId, 'bbbb', '垫了空格照样是合法 JSON');

  const third = session(server, { clock, cache });
  await third.initialize();
  assert.equal(third.get('a').tagId, 'bbbb', '读到的是新内容，不是缓存里那份旧的');
  await third.update('a', { tagId: 'cccc' });
  await settle(third);
  assert.equal(sizes().at(-1), sizes().at(-2) - 1, '再写一版：不用垫了，大小又和上一版不同');

  const fourth = session(server, { clock, cache });
  await fourth.initialize();
  assert.equal(fourth.get('a').tagId, 'cccc');
});

test('清单上有、文件还不存在的分片当成空的；分片读失败、不是 JSON 就整个初始化失败，绝不当成空的往下走', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 4 }, (_, index) => record(`r${index}`, { at: index })));
  const first = session(server, { clock, records: 2 });
  await first.initialize();
  await first.storage.whenIdle();
  assert.deepEqual(server.json(INDEX).segments, ['m0001', 'm0002', 's1']);

  server.failRead = name => name === seg('m0002');
  const broken = session(server, { clock, records: 2 });
  await assert.rejects(broken.initialize(), detailed(/读取画廊元数据失败（HTTP 500）/));
  assert.throws(() => broken.values(), /not initialized/);
  server.failRead = null;
  await broken.initialize();
  assert.deepEqual(ids(broken), ['r0', 'r1', 'r2', 'r3'], '服务器好了再初始化一次就行，中间什么都没写坏');

  const before = server.files.get(seg('m0001'));
  server.put(seg('m0001'), '<html>login</html>');
  const garbled = session(server, { clock, records: 2 });
  await assert.rejects(garbled.initialize(), detailed(/st-image-atelier-gallery-m0001\.json 不是有效 JSON/));
  server.put(seg('m0001'), before);

  server.put(INDEX, '{"schemaVersion":1}');
  await assert.rejects(session(server, { clock }).initialize(), detailed(/清单 st-image-atelier-gallery-index\.json 格式不对/));
});

test('读分片时网络抖了一下：重试就好，不用整个初始化失败；一直不好才报错', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 6 }, (_, index) => record(`r${index}`, { at: index })));
  const first = session(server, { clock, records: 2 });
  await first.initialize();
  await first.storage.whenIdle();

  const failures = new Map();
  server.failRead = name => {
    if (!name.includes('-m000')) return false;
    failures.set(name, (failures.get(name) || 0) + 1);
    return failures.get(name) <= 2;
  };
  const patient = session(server, { clock, records: 2, retryDelaysMs: [0, 0] });
  await patient.initialize();
  assert.deepEqual(ids(patient), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'], '每份失败两次、第三次成功');

  failures.clear();
  const impatient = session(server, { clock, records: 2, retryDelaysMs: [0] });
  await assert.rejects(impatient.initialize(), detailed(/HTTP 500/), '重试完还不行就报错');

  /* 403 这种重试也没用的（登录过期、没权限），不重试。 */
  server.failRead = name => (name === seg('m0002') ? 403 : false);
  server.resetLogs();
  await assert.rejects(session(server, { clock, records: 2, retryDelaysMs: [0, 0] }).initialize(), detailed(/HTTP 403/));
  assert.equal(server.reads.filter(read => read.name === seg('m0002')).length, 1, '只问了一次');

  /* 不是合法 JSON 也一样。 */
  server.failRead = null;
  const before = server.files.get(seg('m0002'));
  server.put(seg('m0002'), 'not json');
  server.resetLogs();
  await assert.rejects(session(server, { clock, records: 2, retryDelaysMs: [0, 0] }).initialize(), detailed(/不是有效 JSON/));
  assert.equal(server.reads.filter(read => read.name === seg('m0002')).length, 1);
  server.put(seg('m0002'), before);
});

test('中间有代理把 ETag 换成了别的格式（样子像，但第一段不是文件大小）：分片大小照样按正文算，不会每次打开都新开分片；看别人加的记录退回到隔一阵才看', async () => {
  const server = createFileServer({ opaqueEtag: true });
  const clock = { now: T0 };
  const cache = createMemorySegmentCache();
  for (const id of ['a', 'b', 'c']) {
    const store = session(server, { clock, cache });
    await store.initialize();
    await store.storage.whenIdle();
    await store.putMany([record(id)]);
    await settle(store);
  }
  assert.deepEqual(server.json(INDEX).segments, ['s1'], '三次打开各出一张图，都进同一个分片');
  assert.deepEqual(Object.keys(server.json(seg('s1')).results), ['a', 'b', 'c']);

  await session(server, { clock, cache }).initialize();
  const store = session(server, { clock, cache });
  await store.initialize();
  assert.equal(server.reads.at(-1).status, 304, '缓存照样能用');
  const file = server.json(seg('s1'));
  file.results.z = { ...store.get('a'), resultId: 'z' };
  server.put(seg('s1'), file);

  server.resetLogs();
  clock.now += 60_000;
  await store.putMany([record('d')]);
  await settle(store);
  assert.equal(server.reads.some(read => read.method === 'HEAD' && read.name === seg('s1')), false, '文件头里看不出大小，就不靠它判断');
  assert.deepEqual(Object.keys(server.json(seg('s1')).results).sort(), ['a', 'b', 'c', 'd', 'z'], '隔了一阵再写：整份读回来，别人加的带上了');
});

test('拆分之后旧文件又被没刷新的旧版页面写过：下次打开把之后新画的接过来，早就删掉的不会回来；没再变就不再下载', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 5 }, (_, index) => record(`r${index}`, { at: index })));
  const first = session(server, { clock });
  await first.initialize();
  await first.storage.whenIdle();
  await first.remove('r1');
  await settle(first);
  const marker = server.json(INDEX).legacy.etag;

  /* 旧版页面：手里还是拆分前的五张，又画了一张，整份写回旧文件。 */
  const stale = JSON.parse(server.files.get(LEGACY));
  stale.results.late = { ...first.get('r0'), ...record('late'), createdAt: new Date(T0 + 3_600_000).toISOString() };
  server.put(LEGACY, stale);

  clock.now = T0 + 2 * 3_600_000;
  server.resetLogs();
  const second = session(server, { clock });
  await second.initialize();
  assert.deepEqual(ids(second), ['late', 'r0', 'r2', 'r3', 'r4'], '接回了 late；删掉的 r1 没回来');
  await second.storage.whenIdle();
  assert.ok(reachable(server).late, '写进分片了');
  assert.notEqual(server.json(INDEX).legacy.etag, marker, '记下旧文件现在的样子');
  assert.equal(server.reads.filter(read => read.name === LEGACY && read.method === 'GET').length, 1);

  server.resetLogs();
  const third = session(server, { clock });
  await third.initialize();
  await third.storage.whenIdle();
  assert.deepEqual(server.reads.filter(read => read.name === LEGACY).map(read => read.method), ['HEAD'], '只看一眼文件头');
  assert.deepEqual(server.uploads, []);
  assert.deepEqual(ids(third), ['late', 'r0', 'r2', 'r3', 'r4']);

  clock.now = T0 + 15 * DAY;
  server.resetLogs();
  await session(server, { clock }).initialize();
  assert.deepEqual(server.reads.filter(read => read.name === LEGACY), [], '两周以后连文件头都不看了');
});

test('两台设备同时第一次打开新版、都动手拆：后拆完的那台发现已经有清单了就改用现成的；先拆完那台后来加的、自己拆的过程中加的，一张不丢', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 40 }, (_, index) => record(`r${index}`, { at: index })));

  /* 慢的那台：读到的时候还没有清单，它的上传都卡在路上。 */
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let gated = true;
  let slowCounter = 0;
  const slow = createSillyTavernGalleryMetadataStore(compat, async (url, options = {}) => {
    if (gated && url === '/api/files/upload') await gate;
    return server.fetch(url, options);
  }, {
    flushDelayMs: 0,
    cache: null,
    segmentBytes: 5_000,
    backend: { now: () => clock.now, newSegmentId: () => `slow${slowCounter += 1}`, warn: () => {} },
  });
  await slow.initialize();
  assert.equal(slow.storage.status().mode, 'legacy');
  /* 拆的过程中它自己也出了一张图，还删了一张旧的。 */
  await slow.putMany([record('during', { at: 8000 })]);
  await slow.remove('r7');

  /* 快的那台：拆完了，又出了一张图。 */
  const fast = session(server, { clock, bytes: 5_000 });
  await fast.initialize();
  await fast.storage.whenIdle();
  assert.equal(fast.storage.status().mode, 'segmented');
  await fast.putMany([record('fresh', { at: 9000 })]);
  await settle(fast);
  const listed = server.json(INDEX).segments;
  assert.ok(reachable(server).fresh);
  const before = Object.fromEntries(listed.filter(id => /^m/.test(id)).map(id => [id, server.files.get(seg(id))]));

  gated = false;
  release();
  await slow.flush();
  await slow.storage.whenIdle();
  assert.equal(slow.storage.status().mode, 'segmented', '慢的那台不再拆，改用现成的分片');
  assert.equal(slow.storage.status().error, '');
  assert.deepEqual(server.json(INDEX).segments.slice(0, listed.length), listed, '快的那台的清单原样在，没被盖掉');
  const found = reachable(server);
  assert.ok(found.fresh, '快的那台后来加的还在');
  assert.ok(found.during, '慢的那台拆的过程中出的图也在');
  assert.equal('r7' in found, false, '慢的那台删掉的那张从分片里去掉了');
  assert.equal(Object.keys(found).length, 41);
  for (const [id, text] of Object.entries(before)) {
    if (!JSON.parse(text).results.r7) assert.equal(server.files.get(seg(id)), text, `${id} 两台写出来的一模一样`);
  }

  /* 之后两台都只写分片，不再碰整份文件。 */
  server.resetLogs();
  await slow.putMany([record('from-slow', { at: 9500 })]);
  await settle(slow);
  await fast.putMany([record('from-fast', { at: 9600 })]);
  await settle(fast);
  assert.equal(names(server.uploads).includes(LEGACY), false);

  const reopened = session(server, { clock, bytes: 5_000 });
  await reopened.initialize();
  await reopened.storage.whenIdle();
  assert.deepEqual(ids(reopened).filter(id => !/^r\d+$/.test(id)), ['during', 'fresh', 'from-fast', 'from-slow']);
  assert.equal(reopened.values().length, 43);
  assert.equal(reopened.has('r7'), false);
});

test('拆的过程中新出的图不进固定名字的分片：另一台设备晚到的同名分片盖上来，这张图也丢不了', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 20 }, (_, index) => record(`r${index}`, { at: index })));

  /* 慢的那台：三个分片的上传都卡在路上。 */
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let gated = true;
  const slow = createSillyTavernGalleryMetadataStore(compat, async (url, options = {}) => {
    if (gated && url === '/api/files/upload') await gate;
    return server.fetch(url, options);
  }, {
    flushDelayMs: 0,
    cache: null,
    segmentBytes: 5_000,
    backend: { now: () => clock.now, newSegmentId: () => 'slow1', warn: () => {} },
  });
  await slow.initialize();

  /* 快的那台：刚打开、还没开始传就出了一张图，然后拆完。 */
  const fast = session(server, { clock, bytes: 5_000 });
  await fast.initialize();
  await fast.putMany([record('window', { at: 8000 })]);
  await settle(fast);
  assert.equal(fast.storage.status().mode, 'segmented');
  const listed = server.json(INDEX).segments;
  assert.deepEqual(listed.slice(0, 3), migrated(3));
  assert.equal(listed.length, 4, '三个固定名字的分片，加一个这次页面自己开的');
  const windowSegment = listed.find(id => server.files.has(seg(id)) && server.json(seg(id)).results.window);
  assert.match(windowSegment, /^s\d+$/, '新出的图在自己开的分片里，不在 m 分片里');
  const before = Object.fromEntries(migrated(3).map(id => [id, server.files.get(seg(id))]));

  gated = false;
  release();
  await slow.storage.whenIdle();
  assert.equal(server.uploads.filter(upload => upload.name === seg('m0003')).length, 2, '慢的那台的同名分片确实后到、盖了上来');
  for (const id of migrated(3)) assert.equal(server.files.get(seg(id)), before[id], `${id} 两台写的一模一样，盖了也没变`);
  assert.ok(reachable(server).window, '快的那台拆的过程中出的图还在');
  assert.equal(Object.keys(reachable(server)).length, 21);
  assert.equal(slow.storage.status().mode, 'segmented');
});

test('开得早的页面改清单时，不会把别的设备刚记下的「旧文件现在的样子」换回手里的旧记号', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 3 }, (_, index) => record(`r${index}`, { at: index })));
  const early = session(server, { clock, records: 3 });
  await early.initialize();
  await early.storage.whenIdle();
  const original = server.json(INDEX).legacy.etag;

  const stale = JSON.parse(server.files.get(LEGACY));
  stale.results.late = { ...early.get('r0'), ...record('late'), createdAt: new Date(T0 + 3_600_000).toISOString() };
  server.put(LEGACY, stale);
  clock.now = T0 + 2 * 3_600_000;
  const other = session(server, { clock, records: 3 });
  await other.initialize();
  await other.storage.whenIdle();
  const updated = server.json(INDEX).legacy.etag;
  assert.notEqual(updated, original);

  /* 开得早的那个页面把尾巴装满，登记下一个分片——要改清单。 */
  for (const id of ['a', 'b', 'c', 'd']) {
    await early.putMany([record(id)]);
    await settle(early);
  }
  assert.ok(server.json(INDEX).segments.length >= 3, '清单确实改过了');
  assert.equal(server.json(INDEX).legacy.etag, updated, '记号还是新的那个');

  server.resetLogs();
  await session(server, { clock, records: 3 }).initialize();
  assert.equal(server.reads.some(read => read.name === LEGACY && read.method === 'GET'), false, '下次打开不用再把旧文件下载一遍');
});

test('页面转入后台前 flush()：要写的分片当场发出去，不等定时器；几个分片一起发', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  await writeLegacy(server, Array.from({ length: 6 }, (_, index) => record(`r${index}`, { at: index })));
  const store = session(server, { clock, records: 2, flushDelayMs: 60_000 });
  await store.initialize();
  await store.storage.whenIdle();
  server.resetLogs();

  /* 三个分片各改一条，都在等一分钟后的合并写；「看一眼服务器上那份」的回音都还在路上。 */
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  server.readGate = (name, method) => (method === 'HEAD' ? gate : null);
  await store.update('r0', { favorite: true });
  await store.update('r2', { favorite: true });
  await store.update('r4', { favorite: true });
  assert.deepEqual(server.issued, []);
  const flushed = store.flush();
  for (let turn = 0; turn < 60; turn += 1) await null;
  assert.deepEqual([...server.issued].sort(), migrated(3).map(seg), '只过了微任务，三个请求都已经发出去了：不等定时器，也不等回音');
  server.readGate = null;
  release();
  await flushed;
  await store.storage.whenIdle();
  assert.equal(reachable(server).r4.favorite, true);
});

test('生成记录也拆开存：记一笔只写一小份；超出上限一截才清一次，清空的分片从清单上摘掉', async () => {
  const server = createFileServer();
  const clock = { now: T0 };
  const attemptSeg = id => `${ATTEMPT_SEGMENT_PREFIX}${id}.json`;
  let counter = 0;
  const open = () => createSillyTavernAttemptStore(compat, server.fetch, {
    flushDelayMs: 0,
    cache: null,
    segmentRecords: 5,
    totalLimit: 20,
    totalSlack: 5,
    backend: { now: () => clock.now, newSegmentId: () => `s${counter += 1}`, warn: () => {} },
  });
  const attempt = index => ({
    attemptId: `a${String(index).padStart(3, '0')}`,
    tagId: `tag-${index}`,
    status: 'succeeded',
    createdAt: new Date(T0 + index * 1000).toISOString(),
    finishedAt: new Date(T0 + index * 1000 + 500).toISOString(),
  });
  const reachableAttempts = () => server.json(ATTEMPT_INDEX_FILE).segments
    .filter(id => server.files.has(attemptSeg(id)))
    .flatMap(id => Object.keys(server.json(attemptSeg(id)).attempts));

  const store = open();
  await store.initialize();
  await store.storage.whenIdle();
  server.resetLogs();
  await store.put(attempt(0), { immediate: true });
  assert.deepEqual(names(server.uploads), [attemptSeg('s1')], '发请求前的那一笔：等它写完，只写了一小份');
  assert.ok(server.uploads[0].bytes < 400);

  for (let index = 1; index < 60; index += 1) {
    await store.put(attempt(index));
    await store.storage.whenIdle();
    assert.ok(store.size <= 25, `第 ${index} 笔之后有 ${store.size} 条`);
    assert.deepEqual(reachableAttempts().sort(), store.values().map(item => item.attemptId).sort(), '顺着清单找到的和内存里的一样');
  }
  assert.ok(store.size >= 20);
  assert.equal(store.has('a059'), true);
  assert.equal(store.has('a000'), false, '最早的清掉了');
  const listed = server.json(ATTEMPT_INDEX_FILE).segments;
  assert.ok(listed.length <= 7, `清单上只剩 ${listed.length} 个分片`);
  assert.equal(server.names(ATTEMPT_SEGMENT_PREFIX).length, listed.filter(id => server.files.has(attemptSeg(id))).length + 1, '清空的分片文件也删了');
  assert.equal(server.files.has(ATTEMPT_STORE_FILE), false);

  const again = open();
  await again.initialize();
  assert.deepEqual(again.values().map(item => item.attemptId).sort(), store.values().map(item => item.attemptId).sort());
  assert.equal(again.forTag('tag-59')[0].attemptId, 'a059');
});

test('runPool：同时最多跑 limit 个，前 limit 个当拍发出；出错的都收集起来，stopOnError 时不再开新的', async () => {
  const started = [];
  let active = 0;
  let peak = 0;
  const task = (index, fail = false) => async () => {
    started.push(index);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    if (fail) throw new Error(`task ${index}`);
  };
  const running = runPool([task(0), task(1), task(2), task(3), task(4)], 2);
  await null;
  await null;
  assert.deepEqual(started, [0, 1], '前两个在同一拍里就开始了');
  assert.deepEqual(await running, []);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);

  started.length = 0;
  const errors = await runPool([task(0, true), task(1), task(2), task(3, true)], 2);
  assert.deepEqual(errors.map(error => error.message), ['task 0', 'task 3']);

  started.length = 0;
  const stopped = await runPool([task(0, true), task(1), task(2), task(3)], 1, { stopOnError: true });
  assert.deepEqual(stopped.map(error => error.message), ['task 0']);
  assert.deepEqual(started, [0]);
  assert.deepEqual(await runPool([], 3), []);
});

test('bytesFromEtag：从酒馆的 ETag 里读出文件大小；别的格式读不出就是 null', () => {
  assert.equal(bytesFromEtag('W/"1f4-19a2b3c4d5e"'), 500);
  assert.equal(bytesFromEtag('"1f4-19a2b3c4d5e"'), 500);
  assert.equal(bytesFromEtag('"abcdef0123456789"'), null);
  assert.equal(bytesFromEtag(''), null);
  assert.equal(bytesFromEtag(undefined), null);
});
