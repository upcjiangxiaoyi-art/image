/* 刷新网页会不会把已经画过的图再画一遍。
   用 tests/helpers/tavern-sim.js 模拟：同一份聊天文件、侧文件、画廊，换一个全新的页面会话，
   再模拟酒馆和别的扩展对楼层的各种重画，数上游请求有没有多发。上游每多一次请求就是多花一次钱。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTavern, openPage, sleep } from '../helpers/tavern-sim.js';

/* 插件自己的 info / warn 只收进内存：多文件并行跑时零散输出会搅坏运行器的消息流。 */
for (const level of ['info', 'warn', 'error']) console[level] = () => {};

const user = mes => ({ is_user: true, name: 'ripple', mes, extra: {} });
const PROMPT_A = 'comic page, a guitarist with messy black hair on stage, dramatic light';
const PROMPT_B = 'comic page, hotpot restaurant, a girl singing with chopsticks';
const draw = prompt => `正文一段。\n\n<draw>${prompt}</draw>`;

async function start(t, options) {
  const tavern = createTavern({ chat: [user('你好')], ...options });
  t.after(() => tavern.dispose());
  return tavern;
}

async function refresh(tavern, page, options) {
  page.close();
  return openPage(tavern, options);
}

function shown(page, tagId) {
  const state = page.state(tagId);
  return {
    results: (state?.results || []).length,
    statuses: (state?.attempts || []).map(attempt => attempt.status),
  };
}

test('自动出过图的：刷新三次、每次酒馆和别的扩展把每一楼都重画一遍，上游一次都不多发，图一直在卡片上', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: true });
  const index = await page.receive(draw(PROMPT_A));
  await page.waitFor(() => tavern.upstreamCalls === 1, { label: '新消息自动画一张' });
  await page.settle(400);
  const [tagId] = page.tagIds(index);
  assert.deepEqual(shown(page, tagId), { results: 1, statuses: ['succeeded'] });
  /* 同一个页面里再怎么重画也不重复；换聊天再切回来（酒馆重发 CHAT_CHANGED）也一样。 */
  await page.churn();
  assert.equal(tavern.upstreamCalls, 1, '同一个页面里重画不重复出图');
  await page.emit('CHAT_CHANGED');
  await page.settle();
  await page.churn();
  assert.equal(tavern.upstreamCalls, 1, '切回聊天不重复出图');

  const savesBefore = tavern.chatSaves;
  for (let round = 1; round <= 3; round += 1) {
    page = await refresh(tavern, page);
    await page.churn();
    assert.equal(tavern.upstreamCalls, 1, `第 ${round} 次刷新后没有多发请求`);
    assert.deepEqual(page.tagIds(index), [tagId], '标签 ID 不变');
    assert.deepEqual(shown(page, tagId), { results: 1, statuses: ['succeeded'] }, '图还在卡片上');
  }
  /* 等过一轮定时扫描（1.5 秒一次）。 */
  await sleep(1700);
  assert.equal(tavern.upstreamCalls, 1, '定时扫描也不会补画');
  assert.equal(tavern.chatSaves, savesBefore, '刷新不重写聊天');
  assert.equal(page.errors.length, 0);
});

test('手动出过图的（当时没开自动）：之后开了自动生图再刷新，不会自动再画一张', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: false });
  const index = await page.receive(draw(PROMPT_A));
  await page.settle();
  assert.equal(tavern.upstreamCalls, 0, '没开自动就不画');
  const attempt = await page.generateManually(index);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(tavern.upstreamCalls, 1);
  await page.settle();
  await page.configure({ autoGenerate: true });
  const [tagId] = page.tagIds(index);

  for (let round = 1; round <= 2; round += 1) {
    page = await refresh(tavern, page);
    await page.churn();
    assert.equal(tavern.upstreamCalls, 1, `第 ${round} 次刷新：有图的卡不会被自动再画`);
    assert.equal(shown(page, tagId).results, 1);
  }
});

test('从没画过的旧楼（当时没开自动）：开了自动再刷新，不会一口气把旧楼补画；之后来新消息只画新的那条', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: false });
  for (const prompt of [PROMPT_A, PROMPT_B, `${PROMPT_A}, night`]) await page.receive(draw(prompt));
  await page.settle();
  await page.configure({ autoGenerate: true });
  await page.churn();
  assert.equal(tavern.upstreamCalls, 0, '打开开关的那个页面里，旧楼不会被补画');

  page = await refresh(tavern, page);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 0, '刷新后旧楼也不补画');

  const index = await page.receive(draw('comic page, a brand new scene'));
  await page.waitFor(() => tavern.upstreamCalls === 1, { label: '新消息自动画' });
  await page.settle(400);
  assert.equal(tavern.upstreamCalls, 1, '只画了新来的那一条');
  assert.deepEqual(tavern.upstreamPrompts, ['comic page, a brand new scene']);
  assert.equal(shown(page, page.tagIds(index)[0]).results, 1);
});

test('侧文件丢了（2.0.0 中文聊天名的侧文件根本写不进酒馆）：刷新后标签 ID 不变、聊天不重写、图还在、不重画', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: true });
  const index = await page.receive(draw(PROMPT_A));
  await page.waitFor(() => tavern.upstreamCalls === 1);
  await page.settle(400);
  const [tagId] = page.tagIds(index);
  const sideFiles = tavern.fileNames('st-image-atelier-chat-');
  assert.equal(sideFiles.length, 1, '侧文件写上了');
  assert.match(sideFiles[0], /^[A-Za-z0-9_.-]+$/, '文件名是酒馆收的');
  assert.equal(tavern.rejectedFileNames.length, 0);

  /* 侧文件没了，自动那条生成记录也被上限清掉了：标记全丢。 */
  tavern.files.delete(sideFiles[0]);
  const attempts = tavern.readFile('st-image-atelier-attempts.json');
  attempts.attempts = {};
  tavern.writeFile('st-image-atelier-attempts.json', attempts);
  const savesBefore = tavern.chatSaves;

  for (let round = 1; round <= 2; round += 1) {
    page = await refresh(tavern, page);
    assert.deepEqual(page.tagIds(index), [tagId], `第 ${round} 次刷新：标签 ID 不能换`);
    await page.churn();
    assert.deepEqual(page.tagIds(index), [tagId]);
    assert.equal(tavern.upstreamCalls, 1, '不重画');
    assert.equal(shown(page, tagId).results, 1, '图按画廊接回卡片');
    assert.equal(tavern.chatSaves, savesBefore, '聊天不重写');
  }
  assert.equal(tavern.fileNames('st-image-atelier-chat-').length, 1, '侧文件补写回来了');
});

test('已经被 2.0.0～2.0.2 换过 ID 的聊天（图在画廊里、卡片上没了）：加载时按「同一楼、同一段提示词」认领回来，不重画', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: true });
  const index = await page.receive(`${draw(PROMPT_A)}\n\n<draw>${PROMPT_B}</draw>`);
  await page.waitFor(() => tavern.upstreamCalls === 2, { label: '两个标签各画一张' });
  await page.settle(500);
  const original = page.tagIds(index);
  assert.equal(original.length, 2);
  page.close();

  /* 模拟那几个版本干的事：这一楼的标签全换了新 ID，侧文件里是空白的新记录，画廊里的图还挂在旧 ID 上。 */
  const reminted = [crypto.randomUUID(), crypto.randomUUID()];
  const chat = tavern.readChat();
  const { messageUuid } = chat[index].extra.stImageAtelier;
  chat[index].extra.stImageAtelier = { messageUuid, tagIds: reminted };
  tavern.chatFile = JSON.stringify(chat);
  const [sideFile] = tavern.fileNames('st-image-atelier-chat-');
  const side = tavern.readFile(sideFile);
  side.tags = Object.fromEntries(reminted.map((tagId, position) => [tagId, {
    promptHash: side.tags[original[position]].promptHash,
    latestResultId: null,
    resultRefs: [],
    autoAttempted: false,
    autoSuppressed: false,
  }]));
  tavern.writeFile(sideFile, side);
  const savesBefore = tavern.chatSaves;

  page = await openPage(tavern);
  assert.equal(page.api.takeAdoptedCount(), 2, '加载完能说出认领了几张（index.js 用它弹提示）');
  assert.equal(page.api.takeAdoptedCount(), 0, '问完清零');
  await page.churn();
  assert.equal(tavern.upstreamCalls, 2, '不重画');
  assert.deepEqual(page.tagIds(index), reminted, '现在的 ID 不再动');
  for (const [position, tagId] of reminted.entries()) {
    const state = page.state(tagId);
    assert.equal(state.results.length, 1, `第 ${position + 1} 个标签的图认领回来了`);
    assert.equal(state.results[0].prompt, [PROMPT_A, PROMPT_B][position], '各认各的，不串');
    assert.equal(state.tag.latestResultId, state.results[0].resultId);
  }
  assert.equal(tavern.chatSaves, savesBefore, '认领不动聊天');
  await page.settle(200);
  const gallery = Object.values(tavern.readFile('st-image-atelier-gallery.json').results);
  assert.deepEqual(gallery.map(record => record.tagId).sort(), [...reminted].sort(), '画廊记录改挂到现在的 ID 上');

  page = await refresh(tavern, page);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 2, '再刷新也不重画');
  assert.equal(page.state(reminted[0]).results.length, 1);
});

test('请求还在路上就刷新（防重复记录、侧文件都没来得及写上服务器）：刷新后不会自动再发一次', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: true });
  await page.settle();
  tavern.fileUploadLatencyMs = 800;
  tavern.upstreamGate = new Promise(() => {});
  const index = await page.receive(draw(PROMPT_A));
  await page.waitFor(() => tavern.upstreamCalls === 1, { label: '请求发出去了' });
  const [tagId] = page.tagIds(index);
  page.close();
  tavern.fileUploadLatencyMs = 0;
  tavern.upstreamGate = null;
  assert.equal(tavern.fileNames('st-image-atelier-chat-').length, 0, '侧文件没写上');

  page = await openPage(tavern);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 1, '刷新后不会自动再发一次请求');
  assert.deepEqual(page.tagIds(index), [tagId], '标签 ID 不变');
});

test('图刚画好就刷新（各文件还在等 1.5～2 秒的合并写）：不会自动重画；转入后台时会先把没写完的写掉，回来图还在', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern, { flushDelayMs: 'production' });
  await page.configure({ autoGenerate: true });
  const index = await page.receive(draw(PROMPT_A));
  await page.waitFor(() => tavern.upstreamCalls === 1);
  const [tagId] = page.tagIds(index);
  await page.waitFor(() => page.state(tagId)?.results?.length === 1, { label: '图上卡片' });
  assert.equal(tavern.files.has('st-image-atelier-gallery.json'), false, '画廊文件还没到合并写的时间');

  /* 手机切到后台：页面发 visibilitychange（index.js 接着调 api.flushPending），然后被系统杀掉。 */
  await page.api.flushPending();
  page.close();
  assert.equal(tavern.files.has('st-image-atelier-gallery.json'), true, '转入后台时画廊记录写掉了');

  page = await openPage(tavern);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 1, '不重画');
  assert.deepEqual(shown(page, tagId), { results: 1, statuses: ['succeeded'] }, '图还在，不是「生成被中断」');
});

test('图刚画好页面就被硬杀（连后台事件都没有）：记录丢了，卡片显示中断，但不会自动重画', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern, { flushDelayMs: 'production' });
  await page.configure({ autoGenerate: true });
  /* 上游要画一两分钟：这期间发请求前那条「生成中」的记录早就写上服务器了。 */
  let release;
  tavern.upstreamGate = new Promise(resolve => { release = resolve; });
  const index = await page.receive(draw(PROMPT_A));
  await page.waitFor(() => tavern.upstreamCalls === 1);
  await page.waitFor(() => tavern.files.has('st-image-atelier-attempts.json'), { label: '防重复记录写上了' });
  release();
  tavern.upstreamGate = null;
  const [tagId] = page.tagIds(index);
  await page.waitFor(() => page.state(tagId)?.results?.length === 1);
  page.close();

  page = await openPage(tavern);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 1, '不会自动重画');
  assert.deepEqual(shown(page, tagId), { results: 0, statuses: ['interrupted'] }, '卡片说明被中断，由人决定要不要重试');
});

test('正常流程不受影响：IPE 事后才把 <draw> 贴进最后一楼会自动画一次；改了旧楼的提示词算新标签也画一次；都只画一次', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: true });
  const index = await page.receive('正文先到，生图段还没贴。');
  await page.settle();
  assert.equal(tavern.upstreamCalls, 0);

  /* IPE 跑完副 AI，把生图段贴进这一楼。 */
  await page.rewrite(index, draw(PROMPT_A), { event: null });
  await page.waitFor(() => tavern.upstreamCalls === 1, { label: '贴进来的标签自动画' });
  await page.settle(400);
  await page.churn();
  await sleep(1700);
  assert.equal(tavern.upstreamCalls, 1, '只画一次：DOM 监听和定时扫描不重复');
  const [first] = page.tagIds(index);

  /* 手动把提示词改了：是个新标签。 */
  await page.rewrite(index, draw(`${PROMPT_A}, rain`));
  await page.waitFor(() => tavern.upstreamCalls === 2, { label: '改过的提示词自动画' });
  await page.settle(400);
  const [second] = page.tagIds(index);
  assert.notEqual(second, first, '提示词变了就是新标签');
  await page.churn();
  assert.equal(tavern.upstreamCalls, 2);

  page = await refresh(tavern, page);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 2, '刷新后都不重画');
  assert.deepEqual(page.tagIds(index), [second]);
});

test('「整理旧数据」：侧文件写不进酒馆就不动聊天（不能把楼里的数据清了、侧文件却没存上）', async t => {
  const tagId = crypto.randomUUID();
  const resultId = crypto.randomUUID();
  const legacy = {
    is_user: false,
    name: '钟由时',
    mes: draw(PROMPT_A),
    extra: {
      stImageAtelier: {
        messageUuid: crypto.randomUUID(),
        tags: [{
          tagId,
          prompt: PROMPT_A,
          ordinal: 0,
          count: 1,
          latestResultId: resultId,
          resultRefs: [{ resultId, path: `user/images/st-image-atelier/${resultId}.png`, createdAt: '2026-11-01T00:00:00.000Z' }],
          autoAttempted: true,
          autoSuppressed: false,
        }],
        schemaVersion: 2,
      },
    },
  };
  const tavern = await start(t, { chat: [user('你好'), legacy] });
  tavern.images.add(`user/images/st-image-atelier/${resultId}.png`);
  tavern.failFilePrefixes = ['st-image-atelier-chat-'];
  let page = await openPage(tavern);
  const before = tavern.chatFile;
  await assert.rejects(page.api.organizeChat(), '侧文件存不上，整理要报错');
  assert.equal(tavern.chatFile, before, '聊天一个字没动');
  assert.equal(Array.isArray(page.chat[1].extra.stImageAtelier.tags), true, '内存里的楼也还是旧格式');

  tavern.failFilePrefixes = [];
  const result = await page.api.organizeChat();
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(tavern.readChat()[1].extra.stImageAtelier), ['messageUuid', 'tagIds']);
  assert.equal(tavern.fileNames('st-image-atelier-chat-').length, 1, '侧文件先写上了');

  page = await refresh(tavern, page);
  await page.churn();
  assert.deepEqual(page.tagIds(1), [tagId], '整理后刷新，标签 ID 不变');
  assert.equal(page.state(tagId).tag.autoAttempted, true, '标记还在');
  assert.equal(tavern.upstreamCalls, 0);
});

test('开场白里的 <draw> 不自动画，之后楼层怎么重画、怎么刷新也不画', async t => {
  const tavern = await start(t);
  let page = await openPage(tavern);
  await page.configure({ autoGenerate: true });
  await page.receive(draw(PROMPT_A), 'first_message');
  await page.settle();
  await page.churn();
  assert.equal(tavern.upstreamCalls, 0, '开场白不自动画');
  page = await refresh(tavern, page);
  await page.churn();
  assert.equal(tavern.upstreamCalls, 0);
});
