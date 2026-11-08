/* 2.0.0 按聊天分的侧文件：记录规范形、写入幂等、文件名。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_TAG_FILE_PREFIX,
  chatTagFileName,
  createMemoryChatTagStore,
  normalizeTagRecord,
  promptHash,
  serializeDocument,
} from '../../src/ui/api/chat-tag-store.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('提示词指纹：一样的字一样，差一个字就不一样；短', () => {
  const long = 'masterpiece, '.repeat(400);
  assert.equal(promptHash(long), promptHash(long));
  assert.notEqual(promptHash(long), promptHash(`${long}!`));
  assert.ok(promptHash(long).length <= 12);
  assert.equal(promptHash(''), promptHash(undefined));
});

test('侧文件名：带聊天名、角色和聊天一起算指纹；同名聊天不同角色不撞；没有聊天名就没有文件', () => {
  const a = chatTagFileName({ chatId: '2026-11-05 @12h 30m 15s 123ms', characterKey: 'char:a.png' });
  const b = chatTagFileName({ chatId: '2026-11-05 @12h 30m 15s 123ms', characterKey: 'char:b.png' });
  assert.match(a, new RegExp(`^${CHAT_TAG_FILE_PREFIX}2026-11-05_12h_30m_15s_123ms-[0-9a-z]+\\.json$`));
  assert.notEqual(a, b);
  assert.equal(chatTagFileName({ chatId: '', characterKey: 'x' }), '');
  assert.match(chatTagFileName({ chatId: '港哥/的聊天?', characterKey: '' }), /^st-image-atelier-chat-港哥_的聊天-[0-9a-z]+\.json$/, '中文留着，文件名里不能用的换掉');
  assert.ok(chatTagFileName({ chatId: 'x'.repeat(200) }).length < 80, '截短');
});

test('记录规范形：只留这几样、顺序固定、类型兜底', () => {
  const record = normalizeTagRecord({
    autoSuppressed: 'yes',
    resultRefs: [{ resultId: 'r1', path: 'p', createdAt: 't' }, { resultId: '' }, null, { resultId: 'r2' }],
    latestResultId: '',
    promptHash: 123,
    extra: 'dropped',
  });
  assert.deepEqual(Object.keys(record), ['promptHash', 'latestResultId', 'resultRefs', 'autoAttempted', 'autoSuppressed']);
  assert.deepEqual(record, {
    promptHash: '123',
    latestResultId: null,
    resultRefs: [{ resultId: 'r1', path: 'p', createdAt: 't' }, { resultId: 'r2', path: '', createdAt: '' }],
    autoAttempted: false,
    autoSuppressed: false,
  });
});

test('写入幂等：一样的内容不写、空文档不建文件、重开再读不写、只有真改了才写一次', async () => {
  const store = createMemoryChatTagStore(null, { chatId: 'c', characterKey: 'k' });
  await store.initialize();
  assert.equal(store.size(), 0);
  await store.flush();
  assert.equal(store.writes, 0, '空的不建文件');

  assert.equal(store.put('t1', { promptHash: 'h1' }), true);
  assert.equal(store.put('t1', { promptHash: 'h1' }), false, '一样的不算改');
  await store.flush();
  assert.equal(store.writes, 1);
  assert.deepEqual(Object.keys(store.document.tags), ['t1']);
  assert.equal(store.document.chatId, 'c');
  assert.equal('updatedAt' in store.document, false, '文档里没有时间戳');

  store.put('t1', { promptHash: 'h1', autoAttempted: false });
  await store.flush();
  assert.equal(store.writes, 1, '等价的记录（默认值补齐）不写');

  const updated = store.update('t1', { latestResultId: 'r1', resultRefs: [{ resultId: 'r1', path: 'p', createdAt: '' }] });
  assert.equal(updated.latestResultId, 'r1');
  store.update('t2', { promptHash: 'h2' });
  await store.flush();
  assert.equal(store.writes, 2, '几次改动合成一次写');

  /* 重开：读回来的内容当作「上次写的」，什么都不动就一次都不写。 */
  const reopened = createMemoryChatTagStore(store.document, { chatId: 'c', characterKey: 'k' });
  await reopened.initialize();
  assert.deepEqual(reopened.get('t1'), updated);
  reopened.put('t1', updated);
  reopened.putMany([['t2', reopened.get('t2')]]);
  await reopened.flush();
  assert.equal(reopened.writes, 0, '重开、重放一遍一样的内容，不写');

  assert.equal(reopened.remove('t2'), true);
  assert.equal(reopened.remove('missing'), false);
  await reopened.flush();
  assert.equal(reopened.writes, 1);
  assert.deepEqual(Object.keys(reopened.document.tags), ['t1']);
});

test('序列化按 tagId 排序：插入顺序不同，字符串一样', () => {
  const left = { schemaVersion: 1, chatId: 'c', characterKey: 'k', tags: { b: normalizeTagRecord({ promptHash: 'b' }), a: normalizeTagRecord({ promptHash: 'a' }) } };
  const right = { schemaVersion: 1, chatId: 'c', characterKey: 'k', tags: { a: normalizeTagRecord({ promptHash: 'a' }), b: normalizeTagRecord({ promptHash: 'b' }) } };
  assert.equal(serializeDocument(left), serializeDocument(right));
});

test('延后合并写：flushDelayMs 内几次改动只写一次；flush 立刻写', async () => {
  const store = createMemoryChatTagStore(null, { flushDelayMs: 30 });
  await store.initialize();
  store.put('a', { promptHash: '1' });
  store.put('b', { promptHash: '2' });
  await delay(5);
  assert.equal(store.writes, 0, '还没到点');
  await delay(60);
  assert.equal(store.writes, 1);
  store.put('c', { promptHash: '3' });
  await store.flush();
  assert.equal(store.writes, 2);
});
