import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationController } from '../../src/ui/state/generation-controller.js';
import { createProblemReporter } from '../../src/ui/pages/error-dialog/error-dialog.js';
import { createStore } from '../../src/ui/state/store.js';
import { DirectError } from '../../src/ui/api/openai-direct.js';

function setup({ generate, attempt, cancel, resolveTags, preset } = {}) {
  const store = createStore();
  store.set({
    settings: { enabled: true, generationProvider: 'openai' },
    preset: preset || { id: 'p1', selectedModel: 'gpt-image-2.5-sunburst', defaultQuality: 'high', sendQuality: true },
  });
  const calls = { generate: [], problems: [], succeeded: 0, errors: [] };
  const persisted = new Map();
  const api = {
    generate: async input => {
      calls.generate.push(input);
      return generate(input, persisted);
    },
    attempt: attempt || (async () => { throw new Error('没有配置轮询'); }),
    cancel: cancel || (async () => {}),
    resolveTags: resolveTags || (async ids => ids.map(tagId => ({
      tagId,
      attempts: persisted.get(tagId) || [],
      results: [],
    }))),
  };
  let sequence = 0;
  const controller = createGenerationController({
    api,
    store,
    compat: { currentChatId: () => 'chat-1' },
    onProblem: (context, retry) => calls.problems.push({ context, retry }),
    onSucceeded: () => { calls.succeeded += 1; },
    onError: (error, title) => calls.errors.push({ error, title }),
    uuid: () => `manual-${sequence += 1}`,
    pollIntervalMs: 0,
  });
  return { store, api, controller, calls, persisted };
}

const tag = { tagId: 'tag-1', prompt: '海边夕阳', ratio: 'portrait', quality: undefined, count: 1, messageUuid: 'm1' };

test('直连出图成功：先显示生成中，完成后刷新卡片、触发画廊清理，并交给报错弹窗判断（成功不弹）', async () => {
  const seen = [];
  const { store, controller, calls } = setup({
    generate: async input => ({ attemptId: input.attemptId, tagId: input.tagId, status: 'succeeded' }),
  });
  store.subscribe(state => seen.push(state.tagStates.get('tag-1')?.attempts?.[0]?.status));
  const result = await controller.generate(tag, 'manual');
  assert.equal(result.status, 'succeeded');
  assert.equal(seen[0], 'generating', '先放一个生成中的乐观状态');
  assert.equal(calls.succeeded, 1);
  assert.equal(calls.problems.length, 1);
  assert.equal(calls.problems[0].context.attempt.status, 'succeeded');
  assert.equal(calls.generate[0].attemptId, 'manual-1', '手动每次用新的 attemptId');
  assert.equal(calls.generate[0].chatId, 'chat-1');
});

test('失败：弹窗用落盘的报错（带重试说明），「重新生成」沿用原请求的临时提示词，错误继续往上抛', async () => {
  const failure = new DirectError('UPSTREAM_HTTP_ERROR', 'bad', 400, false, '上游生图请求失败（HTTP 400）：bad');
  const { controller, calls } = setup({
    generate: async (input, persisted) => {
      persisted.set(input.tagId, [{
        attemptId: input.attemptId,
        status: 'failed',
        errorCode: failure.code,
        errorMessage: `${failure.message}；已尝试移除 quality 后重试一次`,
      }]);
      throw failure;
    },
    preset: { id: 'p1', selectedModel: 'm', defaultQuality: 'max', sendQuality: true },
  });
  await assert.rejects(controller.generate(tag, 'manual', { prompt: '临时改过的提示词' }), failure);
  assert.equal(calls.problems.length, 1);
  const [{ context, retry }] = calls.problems;
  assert.match(context.attempt.errorMessage, /已尝试移除 quality 后重试一次/);
  assert.equal(context.error, failure);
  assert.equal(context.quality, 'max', '带上本次请求实际用的 quality');
  assert.equal(retry.key, 'tag-1');

  await assert.rejects(retry.run(), failure);
  assert.equal(calls.generate.length, 2);
  assert.equal(calls.generate[1].prompt, '临时改过的提示词', '重跑沿用原来的临时提示词');
  assert.equal(calls.generate[1].requestMode, 'manual');
});

test('标签已失效（重 roll、滑走、改动或删除）：安静跳过，不弹窗也不往上抛', async () => {
  const { controller, calls } = setup({
    generate: async () => { throw new DirectError('TAG_NOT_FOUND', '找不到对应的生图标签', 404); },
  });
  assert.equal(await controller.generate(tag, 'auto'), null);
  assert.equal(calls.problems.length, 0);
});

test('自动生图的旧终态记录被原样返回时不再弹旧报错', async () => {
  const { store, controller, calls } = setup({
    generate: async input => ({ attemptId: input.attemptId, status: 'failed', errorMessage: '旧的失败' }),
  });
  store.setTag('tag-1', { tagId: 'tag-1', attempts: [{ attemptId: 'auto:tag-1', status: 'failed' }], results: [] });
  await controller.generate(tag, 'auto');
  assert.equal(calls.problems.length, 0);
});

test('增强模式：轮询到终态，把失败交给报错弹窗', async () => {
  const statuses = ['generating', 'failed'];
  const { store, controller, calls } = setup({
    generate: async input => ({ attemptId: input.attemptId, status: 'generating' }),
    attempt: async attemptId => ({ attemptId, status: statuses.shift(), errorMessage: '服务重启，原生成任务已中断' }),
  });
  const polled = [];
  store.subscribe(state => polled.push(state.tagStates.get('tag-1')?.attempts?.[0]?.status));
  const completed = await controller.generate(tag, 'manual');
  assert.equal(completed.status, 'failed');
  assert.ok(polled.includes('failed'));
  assert.equal(calls.problems.length, 1);
  assert.equal(calls.problems[0].context.attempt.status, 'failed');
});

test('同一张卡生成中再点不会重复请求', async () => {
  let release;
  const { controller, calls } = setup({
    generate: input => new Promise(resolve => { release = () => resolve({ attemptId: input.attemptId, status: 'succeeded' }); }),
  });
  const first = controller.generate(tag, 'manual');
  assert.equal(controller.isActive('tag-1'), true);
  assert.equal(await controller.generate(tag, 'manual'), undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await first;
  assert.equal(calls.generate.length, 1);
  assert.equal(controller.isActive('tag-1'), false);
});

test('失败还没落盘时，卡片显示本地的失败记录', async () => {
  const { store, controller } = setup({
    generate: async () => { throw new DirectError('LOCAL_SAVE_FAILED', '无法在扣费前保存防重复记录'); },
  });
  await assert.rejects(controller.generate(tag, 'manual'));
  const attempt = store.state.tagStates.get('tag-1').attempts[0];
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.errorCode, 'LOCAL_SAVE_FAILED');
});

test('取消：成功后刷新那张卡；失败交给报错弹窗并往上抛', async () => {
  const refreshed = [];
  const { store, controller, calls } = setup({
    resolveTags: async ids => { refreshed.push(...ids); return ids.map(tagId => ({ tagId, attempts: [], results: [] })); },
  });
  store.setTag('tag-1', { tagId: 'tag-1', attempts: [{ attemptId: 'a-1', status: 'generating' }], results: [] });
  await controller.cancel('a-1');
  assert.deepEqual(refreshed, ['tag-1']);

  const failing = setup({ cancel: async () => { throw new Error('网络断了'); } });
  await assert.rejects(failing.controller.cancel('a-1'), /网络断了/);
  assert.equal(failing.calls.errors[0].title, '取消失败');
});

test('报错弹窗开关关掉就不弹；只有失败带「重新生成」，参数回退提醒不带', () => {
  const shown = [];
  const store = createStore();
  const reporter = createProblemReporter({ store, getDialog: () => ({ show: problem => shown.push(problem) }) });
  const retry = { key: 'tag-1', run() {} };

  reporter.reportProblem({ attempt: { status: 'failed', errorMessage: '请求超时', errorCode: 'UPSTREAM_TIMEOUT' } }, retry);
  assert.equal(shown.at(-1).retry, retry);
  reporter.reportProblem({
    attempt: { status: 'succeeded', compatibilityRetry: { adjustedParameters: ['quality'] } },
    quality: 'max',
  }, retry);
  assert.equal(shown.at(-1).tone, 'warning');
  assert.equal('retry' in shown.at(-1), false);
  reporter.reportProblem({ attempt: { status: 'succeeded' } }, retry);
  assert.equal(shown.length, 2, '普通成功不弹');

  store.set({ settings: { ...store.state.settings, enableErrorPopup: false } });
  reporter.reportError(new Error('x'), '设置操作失败');
  reporter.reportProblem({ attempt: { status: 'failed', errorMessage: 'y' } }, retry);
  assert.equal(shown.length, 2, '开关关掉后什么都不弹');

  store.set({ settings: { ...store.state.settings, enableErrorPopup: true } });
  const quiet = createProblemReporter({ store, getDialog: () => null });
  assert.doesNotThrow(() => quiet.reportError(new Error('页面还没就绪'), '操作失败'), '弹窗还没创建时安静跳过');
});
