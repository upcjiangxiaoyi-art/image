/* 2.4.0 画廊索引、生成记录拆成小文件：整条链路（真的直连客户端、事件、自动队列）对着模拟酒馆跑。
   重点是从 2.3.0 升上来的老用户：服务器上只有两份整份的文件，第一次打开要在后台拆开，期间什么都不能坏。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTavern, openPage, sleep } from '../helpers/tavern-sim.js';

/* 插件自己的 info / warn 只收进内存：多文件并行跑时零散输出会搅坏运行器的消息流。 */
for (const level of ['info', 'warn', 'error']) console[level] = () => {};

const GALLERY = 'st-image-atelier-gallery.json';
const ATTEMPTS = 'st-image-atelier-attempts.json';
const GALLERY_INDEX = 'st-image-atelier-gallery-index.json';
const user = mes => ({ is_user: true, name: 'ripple', mes, extra: {} });
const draw = prompt => `正文一段。\n\n<draw>${prompt}</draw>`;
const isMetadata = name => /^st-image-atelier-(gallery|attempts)/.test(name);

async function start(t) {
  const tavern = createTavern({ chat: [user('你好')] });
  t.after(() => tavern.dispose());
  return tavern;
}

function shown(page, tagId) {
  const state = page.state(tagId);
  return {
    results: (state?.results || []).length,
    statuses: (state?.attempts || []).map(attempt => attempt.status),
  };
}

/* 先用现在的版本画两张图，拿到真实的记录。 */
async function seed(tavern) {
  const page = await openPage(tavern);
  await page.configure({ autoGenerate: true });
  const first = await page.receive(draw('comic page, a guitarist on stage'));
  const second = await page.receive(draw('comic page, hotpot restaurant'));
  await page.waitFor(() => tavern.upstreamCalls === 2, { label: '两张都画了' });
  await page.settle(400);
  const tagIds = [page.tagIds(first)[0], page.tagIds(second)[0]];
  page.close();
  return tagIds;
}

/* 把服务器上的画廊索引、生成记录还原成 2.3.0 的样子：各一整份文件，没有清单、没有分片。
   bulk：再塞进这么多张别的聊天的旧图（提示词三千来字）和它们的生成记录。 */
function toLegacyLayout(tavern, { bulk = 0 } = {}) {
  const gallery = tavern.records('gallery');
  const attempts = tavern.records('attempts');
  for (let index = 0; index < bulk; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
    gallery.push({
      ...gallery[0],
      resultId: `bulk-result-${index}`,
      tagId: `bulk-tag-${index}`,
      messageUuid: `bulk-message-${index}`,
      chatId: '别的聊天',
      prompt: `comic page ${index}, `.padEnd(3000, 'storyboard panel, dramatic light, '),
      createdAt,
      localRelativePath: `user/images/st-image-atelier/bulk-${index}.png`,
    });
    attempts.push({ ...attempts[0], attemptId: `bulk-attempt-${index}`, tagId: `bulk-tag-${index}`, createdAt });
  }
  for (const kind of ['gallery', 'attempts']) {
    for (const name of tavern.fileNames(`st-image-atelier-${kind}-`)) tavern.files.delete(name);
  }
  tavern.writeFile(GALLERY, {
    schemaVersion: 1,
    results: Object.fromEntries(gallery.map(record => [record.resultId, record])),
    updatedAt: '2026-11-11T00:00:00.000Z',
  });
  tavern.writeFile(ATTEMPTS, {
    schemaVersion: 1,
    attempts: Object.fromEntries(attempts.map(record => [record.attemptId, record])),
    updatedAt: '2026-11-11T00:00:00.000Z',
  });
  return { gallery: tavern.files.get(GALLERY), attempts: tavern.files.get(ATTEMPTS) };
}

/* 等后台把两份都拆完。 */
async function split(page) {
  for (let turn = 0; turn < 800; turn += 1) {
    const status = await page.api.storageStatus();
    if (status.gallery.mode === 'segmented' && status.attempts.mode === 'segmented') return status;
    await sleep(10);
  }
  throw new Error(`没等到拆分完成：${JSON.stringify(await page.api.storageStatus())}`);
}

test('从 2.3.0 升上来第一次打开：图都在、不重画、聊天不动；后台拆完后旧文件原样留着；之后出图不再写整份文件；再刷新什么都不写', async t => {
  const tavern = await start(t);
  const tagIds = await seed(tavern);
  const legacy = toLegacyLayout(tavern);
  const savesBefore = tavern.chatSaves;
  tavern.uploads.length = 0;

  let page = await openPage(tavern);
  for (const tagId of tagIds) assert.deepEqual(shown(page, tagId), { results: 1, statuses: ['succeeded'] }, '图在卡片上');
  const status = await split(page);
  assert.equal(status.gallery.records, 2);
  assert.equal(status.gallery.error, '');
  await page.churn();
  assert.equal(tavern.upstreamCalls, 2, '不重画');
  assert.equal(tavern.chatSaves, savesBefore, '聊天不动');
  assert.equal(tavern.files.get(GALLERY), legacy.gallery, '旧的画廊索引原样留着');
  assert.equal(tavern.files.get(ATTEMPTS), legacy.attempts, '旧的生成记录原样留着');
  assert.equal(tavern.records('gallery').length, 2);
  assert.equal(tavern.records('attempts').length, 2);
  assert.equal(tavern.rejectedFileNames.length, 0, '文件名都是酒馆收的');

  tavern.uploads.length = 0;
  const third = await page.receive(draw('comic page, a third scene'));
  await page.waitFor(() => tavern.upstreamCalls === 3, { label: '新消息照常自动画' });
  await page.settle(400);
  const names = tavern.uploads.map(upload => upload.name);
  assert.equal(names.includes(GALLERY) || names.includes(ATTEMPTS), false, '不再写整份文件');
  assert.equal(tavern.records('gallery').length, 3);
  assert.equal(tavern.records('attempts').length, 3);

  page.close();
  tavern.uploads.length = 0;
  const savesAfterThird = tavern.chatSaves;
  page = await openPage(tavern);
  await page.churn();
  await page.settle(300);
  assert.equal(tavern.upstreamCalls, 3, '刷新不重画');
  for (const tagId of [...tagIds, page.tagIds(third)[0]]) assert.equal(shown(page, tagId).results, 1);
  assert.deepEqual(tavern.uploads.map(upload => upload.name), [], '刷新不写任何文件');
  assert.equal(tavern.chatSaves, savesAfterThird, '刷新不存聊天');
});

test('拆到一半页面关了（期间还出了一张图）：再打开图都在、不重画，从头拆完，那张图也在', async t => {
  const tavern = await start(t);
  const tagIds = await seed(tavern);
  toLegacyLayout(tavern, { bulk: 1000 });

  /* 上传慢：一千张图要拆成二十来份，一份一份传要两三秒。 */
  tavern.fileUploadLatencyMs = 250;
  let page = await openPage(tavern);
  const third = await page.receive(draw('comic page, drawn while splitting'));
  await page.waitFor(() => tavern.upstreamCalls === 3, { label: '拆分期间照常出图' });
  const [thirdTag] = page.tagIds(third);
  await page.waitFor(() => page.state(thirdTag)?.results?.length === 1, { label: '图上卡片' });
  await page.api.flushPending();
  assert.equal((await page.api.storageStatus()).gallery.mode, 'legacy', '这时候还没拆完');
  page.close();
  assert.equal(tavern.files.has(GALLERY_INDEX), false, '清单没写：服务器上还是旧文件说了算');
  assert.equal(Object.keys(tavern.readFile(GALLERY).results).length, 1003, '新出的那张照旧写进了整份文件');

  tavern.fileUploadLatencyMs = 0;
  page = await openPage(tavern);
  for (const tagId of [...tagIds, thirdTag]) assert.equal(shown(page, tagId).results, 1, '图都在');
  const status = await split(page);
  assert.equal(status.gallery.records, 1003);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 3, '不重画');
  assert.equal(tavern.records('gallery').length, 1003, '一条不少');
  assert.equal(tavern.records('attempts').length, 1003);
  /* 清单上最后一个是登记好、还没有文件的新分片；所以文件数 = 清单上的分片数 - 1，再加清单自己。 */
  const listed = tavern.readFile(GALLERY_INDEX).segments.length;
  assert.equal(tavern.fileNames('st-image-atelier-gallery-').length, listed, '上次传了一半的那些被覆盖了，没有多出来的文件');
});

test('画廊里有一千张旧图：出一张新图要上传的索引和记录，只有以前整份重写的一小部分，而且每个文件都不超上限', async t => {
  const tavern = await start(t);
  await seed(tavern);
  const legacy = toLegacyLayout(tavern, { bulk: 1000 });
  const galleryBytes = Buffer.byteLength(legacy.gallery);
  const attemptBytes = Buffer.byteLength(legacy.attempts);
  assert.ok(galleryBytes > 3_000_000, `旧的画廊索引有 ${galleryBytes} 字节`);

  const page = await openPage(tavern);
  await split(page);
  tavern.uploads.length = 0;
  const index = await page.receive(draw('comic page, one more scene'));
  await page.waitFor(() => tavern.upstreamCalls === 3);
  await page.waitFor(() => page.state(page.tagIds(index)[0])?.results?.length === 1);
  await page.settle(600);

  const metadata = tavern.uploads.filter(upload => isMetadata(upload.name));
  const total = metadata.reduce((sum, upload) => sum + upload.bodyBytes, 0);
  /* 2.3.0 出一张图：画廊索引整份写一次，生成记录整份写两次（发请求前、画完后），都是 base64。 */
  const before = Math.ceil((galleryBytes + 2 * attemptBytes) * 4 / 3);
  assert.ok(metadata.length >= 2 && metadata.length <= 5, `写了 ${metadata.length} 个文件：${metadata.map(upload => upload.name)}`);
  assert.ok(metadata.every(upload => upload.bytes <= 165_000), `最大的一个 ${Math.max(...metadata.map(upload => upload.bytes))} 字节`);
  assert.ok(total < 600_000, `这张图上传了 ${total} 字节的索引和记录`);
  assert.ok(total < before / 8, `以前是 ${before} 字节，现在 ${total} 字节`);
  assert.equal(tavern.records('gallery').length, 1003);
});
