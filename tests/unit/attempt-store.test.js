import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTEMPTS_PER_TAG,
  MAX_ATTEMPTS_TOTAL,
  createAttemptStore,
  createMemoryAttemptStore,
} from '../../src/ui/api/attempt-store.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function attempt(attemptId, tagId, overrides = {}) {
  return {
    attemptId,
    tagId,
    status: 'succeeded',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

test('同一拍里的多次写入合并成一次落盘，put 在写完后才 resolve；进度更新只改内存', async () => {
  const store = createMemoryAttemptStore();
  await store.initialize();
  const first = store.put(attempt('a', 't'));
  const second = store.put(attempt('b', 't', { createdAt: '2026-10-01T00:00:01.000Z' }));
  assert.equal(store.writes, 0, '还没到下一拍，没写');
  assert.equal(store.has('a'), true, '内存里立刻能读到');
  await Promise.all([first, second]);
  assert.equal(store.writes, 1, '两次 put 合并成一次写');
  assert.deepEqual(Object.keys(store.document.attempts).sort(), ['a', 'b']);

  await store.put({ ...attempt('a', 't'), status: 'downloading' }, { persist: false });
  await tick();
  assert.equal(store.writes, 1, '进度更新不落盘');
  assert.equal(store.get('a').status, 'downloading', '但内存里是新的');
  await store.put({ ...attempt('a', 't'), status: 'succeeded' });
  assert.equal(store.writes, 2);
  assert.equal(store.document.attempts.a.status, 'succeeded');
});

test('按标签读：最近开始的在前，同一毫秒开始的后写的在前；读出来的是拷贝', async () => {
  const store = createMemoryAttemptStore();
  await store.initialize();
  await store.putMany([
    attempt('old', 't', { createdAt: '2026-10-01T00:00:00.000Z' }),
    attempt('tie-1', 't', { createdAt: '2026-10-01T00:00:05.000Z' }),
    attempt('tie-2', 't', { createdAt: '2026-10-01T00:00:05.000Z' }),
    attempt('other', 'u', { createdAt: '2026-10-02T00:00:00.000Z' }),
  ]);
  assert.deepEqual(store.forTag('t').map(item => item.attemptId), ['tie-2', 'tie-1', 'old']);
  assert.deepEqual(store.forTag('u').map(item => item.attemptId), ['other']);
  assert.deepEqual(store.forTag('missing'), []);
  store.forTag('t')[0].status = 'changed';
  assert.equal(store.get('tie-2').status, 'succeeded', '改拷贝不影响存储');
});

test('每个标签最多留 20 条、整份最多 2000 条：删最早结束的，还在画的不删', async () => {
  assert.equal(MAX_ATTEMPTS_PER_TAG, 20);
  assert.equal(MAX_ATTEMPTS_TOTAL, 2000);
  const store = createMemoryAttemptStore(null, { perTagLimit: 3, totalLimit: 5 });
  await store.initialize();
  const at = index => `2026-10-01T00:00:${String(index).padStart(2, '0')}.000Z`;
  await store.putMany([
    attempt('t-1', 't', { createdAt: at(1), status: 'generating' }),
    attempt('t-2', 't', { createdAt: at(2) }),
    attempt('t-3', 't', { createdAt: at(3) }),
    attempt('t-4', 't', { createdAt: at(4) }),
  ]);
  assert.deepEqual(store.forTag('t').map(item => item.attemptId), ['t-4', 't-3', 't-1'], '最早结束的 t-2 被删，还在画的 t-1 留着');

  await store.putMany([
    attempt('u-1', 'u', { createdAt: at(10) }),
    attempt('u-2', 'u', { createdAt: at(11) }),
    attempt('u-3', 'u', { createdAt: at(12) }),
  ]);
  assert.equal(store.size, 5, '整份超过 5 条时也删最早结束的');
  assert.equal(store.has('t-3'), false);
  assert.equal(store.has('t-1'), true, '还在画的不算');
  assert.deepEqual(store.forTag('u').map(item => item.attemptId), ['u-3', 'u-2', 'u-1']);
});

test('按标签整个删掉；读文件时丢掉没有 tagId 的记录', async () => {
  const store = createMemoryAttemptStore({
    schemaVersion: 1,
    attempts: {
      keep: attempt('keep', 't'),
      broken: { attemptId: 'broken', status: 'failed' },
      other: attempt('other', 'u'),
    },
  });
  await store.initialize();
  assert.equal(store.has('broken'), false);
  assert.equal(store.has('keep'), true);
  await store.removeForTag('t');
  assert.deepEqual(store.forTag('t'), []);
  assert.equal(store.has('other'), true);
  assert.equal(store.document.attempts.keep, undefined, '写进了文件');
  await store.removeForTag('missing');
});

test('写失败时 put 拒绝，下一次写入照常进行；初始化失败可以重试', async () => {
  let failNext = true;
  let document = null;
  const store = createAttemptStore({
    readDocument: async () => {
      if (!document) throw new Error('disk error');
      return document;
    },
    writeDocument: async value => {
      if (failNext) {
        failNext = false;
        throw new Error('upload failed');
      }
      document = value;
    },
  });
  await assert.rejects(store.initialize(), /disk error/);
  document = { schemaVersion: 1, attempts: {} };
  await store.initialize();
  await assert.rejects(store.put(attempt('a', 't')), /upload failed/);
  await store.put(attempt('b', 't'));
  assert.deepEqual(Object.keys(document.attempts).sort(), ['a', 'b'], '上一次没写成的记录随下一次一起写进去');
});
