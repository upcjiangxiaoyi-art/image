import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationController } from '../../src/ui/state/generation-controller.js';
import { createProblemReporter } from '../../src/ui/pages/error-dialog/error-dialog.js';
import { createStore } from '../../src/ui/state/store.js';
import { DirectError } from '../../src/ui/api/openai-direct.js';

function setup({ generate, attempt, cancel, resolveTags, preset, compat, settings, presets } = {}) {
  const store = createStore();
  store.set({
    settings: { enabled: true, generationProvider: 'openai', ...settings },
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
    mode: () => 'direct',
    getPresets: async () => ({ activePresetId: 'p1', items: presets || [] }),
  };
  let sequence = 0;
  const controller = createGenerationController({
    api,
    store,
    compat: compat || { currentChatId: () => 'chat-1' },
    onProblem: (context, retry, fallback) => calls.problems.push({ context, retry, fallback }),
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

test('出结果时卡片已经不在眼前：告诉报错弹窗图在哪；失败也不带「重新生成」，免得点了没反应', async () => {
  const current = { tags: [{ tagId: 'tag-1' }] };
  const message = {
    swipe_id: 0,
    swipes: ['这一版'],
    swipe_info: [{ extra: {} }],
    extra: { stImageAtelier: current },
  };
  const chat = [message];
  let chatId = 'chat-1';
  let duringGeneration = () => {};
  let failure = null;
  const { controller, calls } = setup({
    compat: { chat: () => chat, currentChatId: () => chatId },
    generate: async input => {
      duringGeneration();
      if (failure) throw failure;
      return { attemptId: input.attemptId, tagId: input.tagId, status: 'succeeded', resultIds: ['r-1'] };
    },
  });
  const lastProblem = () => calls.problems.at(-1);

  await controller.generate(tag, 'manual');
  assert.equal(lastProblem().context.placement, 'active');
  assert.ok(lastProblem().retry, '卡片还在眼前时照常带「重新生成」');

  duringGeneration = () => {
    message.swipe_info[0].extra = structuredClone(message.extra);
    message.swipe_id = 1;
    message.swipes.push('新的一版');
    message.swipe_info.push({ extra: {} });
    message.extra = { stImageAtelier: { tags: [{ tagId: 'tag-new' }] } };
  };
  await controller.generate(tag, 'manual');
  assert.equal(lastProblem().context.placement, 'swipe', '滑到了新的一版');
  assert.equal(lastProblem().context.attempt.resultIds[0], 'r-1');
  assert.equal(lastProblem().retry, undefined);

  duringGeneration = () => { chat.splice(0, 1, { extra: {} }); };
  await controller.generate(tag, 'manual');
  assert.equal(lastProblem().context.placement, 'gone', '回复被重新生成');

  duringGeneration = () => { chatId = 'chat-2'; };
  await controller.generate(tag, 'manual');
  assert.equal(lastProblem().context.placement, 'elsewhere', '生成途中切到了别的聊天');

  chatId = 'chat-1';
  duringGeneration = () => {};
  failure = new DirectError('UPSTREAM_TIMEOUT', '请求超时');
  await assert.rejects(controller.generate(tag, 'manual'), failure);
  assert.equal(lastProblem().context.placement, 'gone');
  assert.equal(lastProblem().retry, undefined, '卡片都不在了，重跑只会被当成失效标签跳过');
});

test('等不及「再画一张」：正在画的留在后台，新的一张照原请求用选的预设；后台那张画好时标为 background、不带重试', async () => {
  const pending = new Map();
  const { store, controller, calls } = setup({
    generate: input => new Promise((resolve, reject) => {
      pending.set(input.attemptId, {
        succeed: () => resolve({ attemptId: input.attemptId, tagId: input.tagId, status: 'succeeded', resultIds: [`r-${input.attemptId}`] }),
        fail: error => reject(error),
      });
    }),
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const fast = { id: 'fast', name: '快速组', selectedModel: 'gpt-image-2.5-flare', defaultQuality: 'high', sendQuality: true };

  const slow = controller.generate(tag, 'manual', { prompt: '调整过的提示词' });
  await settle();
  assert.equal(await controller.generate(tag, 'manual'), undefined, '正在画时普通的「生成」不再发请求（防双击）');
  assert.equal(calls.generate.length, 1);

  const quick = controller.reroll(tag, 'manual-1', fast);
  await settle();
  assert.equal(calls.generate.length, 2);
  assert.equal(calls.generate[1].presetId, 'fast', '用选的预设');
  assert.equal(calls.generate[1].prompt, '调整过的提示词', '照正在画的那次请求，临时提示词也带上');
  const shown = store.state.tagStates.get('tag-1').attempts;
  assert.deepEqual(shown.map(item => item.attemptId), ['manual-2', 'manual-1'], '卡片显示新的这次，旧的在后面');
  assert.equal(shown[0].model, 'gpt-image-2.5-flare');
  assert.equal(controller.isActive('tag-1'), true);

  pending.get('manual-2').succeed();
  await quick;
  const [newer] = calls.problems.slice(-1);
  assert.equal(newer.context.background, false);
  assert.ok(newer.retry, '新的这次照常带「重新生成」');

  const again = controller.generate(tag, 'manual');
  await settle();
  assert.equal(calls.generate.length, 3, '只剩后台那张在画时，卡片上的「重新生成」照常能用');
  pending.get('manual-3').succeed();
  await again;

  pending.get('manual-1').succeed();
  await slow;
  const [late] = calls.problems.slice(-1);
  assert.equal(late.context.attempt.attemptId, 'manual-1');
  assert.equal(late.context.background, true, '之后又 roll 过，这张是后台那张');
  assert.equal(late.retry, undefined);
  assert.equal(controller.isActive('tag-1'), false);
});

test('后台那张没画成：照样报错但不带「重新生成」；新的这次失败时的「重新生成」可以和后台那张并行', async () => {
  const pending = new Map();
  const { controller, calls } = setup({
    generate: input => new Promise((resolve, reject) => {
      pending.set(input.attemptId, { reject });
    }),
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const slow = controller.generate(tag, 'manual');
  await settle();
  const quick = controller.reroll(tag, 'manual-1');
  await settle();

  const failure = new DirectError('UPSTREAM_HTTP_ERROR', 'bad', 502, true, '上游服务器出错');
  pending.get('manual-2').reject(failure);
  await assert.rejects(quick, failure);
  const [newer] = calls.problems.slice(-1);
  assert.equal(newer.context.background, false);
  const retried = newer.retry.run();
  await settle();
  assert.equal(calls.generate.length, 3, '弹窗里的「重新生成」不被后台那张挡住');
  pending.get('manual-3').reject(failure);
  await assert.rejects(retried, failure);

  pending.get('manual-1').reject(new DirectError('UPSTREAM_TIMEOUT', '请求超时'));
  await assert.rejects(slow);
  const [late] = calls.problems.slice(-1);
  assert.equal(late.context.background, true);
  assert.equal(late.retry, undefined, '用户已经换着重新 roll 过了');
});

test('增强模式轮询时，后台那张的进度不会被挪到卡片最前面', async () => {
  const statuses = new Map();
  const { store, controller } = setup({
    generate: async input => {
      statuses.set(input.attemptId, ['generating', 'generating', 'succeeded']);
      return { attemptId: input.attemptId, tagId: input.tagId, status: 'generating', createdAt: new Date().toISOString() };
    },
    attempt: async attemptId => ({ attemptId, tagId: 'tag-1', status: statuses.get(attemptId).shift() || 'succeeded' }),
  });
  let rerolled = false;
  const fronts = [];
  store.subscribe(state => {
    if (rerolled) fronts.push(state.tagStates.get('tag-1')?.attempts?.[0]?.attemptId);
  });
  const slow = controller.generate(tag, 'manual');
  rerolled = true;
  const quick = controller.reroll(tag, 'manual-1');
  await Promise.all([slow, quick]);
  const polled = fronts.filter(Boolean);
  assert.ok(polled.length > 2);
  assert.ok(polled.every(attemptId => attemptId === 'manual-2'), `卡片最前面一直是新的这次：${polled.join(',')}`);
});

test('读回来的旧状态不会把已经画好的卡片打回「正在保存到酒馆」', async () => {
  const { store, controller } = setup({
    generate: async (input, persisted) => {
      persisted.set(input.tagId, [{ attemptId: input.attemptId, status: 'succeeded', resultIds: ['r-1'] }]);
      return { attemptId: input.attemptId, tagId: input.tagId, status: 'succeeded', resultIds: ['r-1'] };
    },
  });
  await controller.generate(tag, 'manual');
  assert.equal(store.state.tagStates.get('tag-1').attempts[0].status, 'succeeded');

  const stale = { tagId: 'tag-1', attempts: [{ attemptId: 'manual-1', status: 'saving' }], results: [] };
  assert.equal(store.applyResolvedTag('tag-1', stale), false, '开始读时还在保存，读完时已经画好：不用这份');
  assert.equal(store.state.tagStates.get('tag-1').attempts[0].status, 'succeeded');

  const fresh = {
    tagId: 'tag-1',
    attempts: [{ attemptId: 'manual-2', status: 'generating' }, { attemptId: 'manual-1', status: 'succeeded' }],
    results: [{ resultId: 'r-1', status: 'available' }],
  };
  assert.equal(store.applyResolvedTag('tag-1', fresh), true, '有新的一次在画、旧的已结束：照常更新');
  assert.equal(
    store.applyResolvedTag('tag-1', { ...fresh, attempts: [{ attemptId: 'manual-2', status: 'interrupted' }, fresh.attempts[1]] }),
    true,
    '进行中变成结束是往前走，照常更新',
  );
  assert.equal(store.applyResolvedTag('tag-1', { tagId: 'tag-1', tag: null, attempts: [], results: [] }), true, '标签删掉了也照常更新');
});

const BACKUP = { id: 'stable', name: '稳定组', selectedModel: 'gpt-image-2.5-sunburst', defaultQuality: 'max', sendQuality: true };
const MAIN = { id: 'p1', name: '便宜组', selectedModel: 'gpt-image-2.5-sunburst', defaultQuality: 'high', sendQuality: true };

test('备用线路：主线路失败时弹窗带「换备用线路重画」，照原请求只换线路；备用线路自己失败就不再给', async () => {
  const outcomes = [new DirectError('UPSTREAM_HTTP_ERROR', 'bad gateway', 502, true, '上游生图请求失败（HTTP 502）：bad gateway')];
  const { controller, calls } = setup({
    preset: MAIN,
    presets: [MAIN, BACKUP],
    settings: { backupPresetId: 'stable' },
    generate: async input => {
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
      return { attemptId: input.attemptId, tagId: input.tagId, status: 'succeeded', resultIds: ['r'] };
    },
  });
  await assert.rejects(controller.generate(tag, 'manual', { prompt: '调整过的提示词' }));
  const [{ context, retry }] = calls.problems.slice(-1);
  const fallback = calls.problems.at(-1).fallback;
  assert.ok(retry, '原线路的「重新生成」照旧在');
  assert.equal(fallback.label, '稳定组');
  assert.equal(context.attempt.status, 'failed');

  const rerolled = await fallback.run();
  assert.equal(rerolled.status, 'succeeded');
  assert.equal(calls.generate[1].presetId, 'stable', '换成备用线路');
  assert.equal(calls.generate[1].prompt, '调整过的提示词', '临时提示词照带');

  outcomes.push(new DirectError('UPSTREAM_HTTP_ERROR', 'still down', 502, true, '上游生图请求失败（HTTP 502）'));
  await assert.rejects(controller.generate(tag, 'manual', { preset: BACKUP }));
  assert.equal(calls.problems.at(-1).fallback, undefined, '这次用的本来就是备用线路，不再给换');
});

test('自动换备用线路：开了开关又明显是线路挂了，不弹报错直接换，卡片上写一句；超时、审核拦截不自动换', async () => {
  const outcomes = [];
  const { store, controller, calls } = setup({
    preset: MAIN,
    presets: [MAIN, BACKUP],
    settings: { backupPresetId: 'stable', enableAutoFallback: true },
    generate: async input => {
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
      return { attemptId: input.attemptId, tagId: input.tagId, status: 'succeeded', resultIds: ['r'] };
    },
  });
  const seen = [];
  store.subscribe(state => seen.push(state.tagStates.get('tag-1')?.attempts?.[0]?.statusMessage));

  outcomes.push(new DirectError('DIRECT_FETCH_BLOCKED', 'Failed to fetch', 0, true));
  const result = await controller.generate(tag, 'auto');
  assert.equal(result.status, 'succeeded', '自动换了备用线路，最后拿到的是备用线路的结果');
  assert.equal(calls.generate.length, 2);
  assert.equal(calls.generate[1].presetId, 'stable');
  assert.equal(calls.generate[1].statusMessage, '主线路连不上服务器，已换备用线路「稳定组」重画');
  assert.ok(seen.includes('主线路连不上服务器，已换备用线路「稳定组」重画'), '卡片上写了换线路的原因');
  assert.equal(calls.problems.filter(item => item.context.attempt.status === 'failed').length, 0, '主线路的失败不弹窗');

  outcomes.push(new DirectError('UPSTREAM_TIMEOUT', '请求已超时或取消', 504, true));
  await assert.rejects(controller.generate(tag, 'manual'));
  assert.equal(calls.generate.length, 3, '超时不自动换：中转站可能还在画、照样扣钱');
  assert.equal(calls.problems.at(-1).fallback.label, '稳定组', '但弹窗里可以自己点');

  outcomes.push(new DirectError('UPSTREAM_HTTP_ERROR', 'prompt is unsafe', 400, false, '上游生图请求失败（HTTP 400）：prompt is unsafe'));
  await assert.rejects(controller.generate(tag, 'manual'));
  assert.equal(calls.generate.length, 4, '审核拦截不自动换');

  outcomes.push(
    new DirectError('UPSTREAM_RATE_LIMITED', 'too many requests', 429, true),
    new DirectError('UPSTREAM_HTTP_ERROR', 'backup down', 502, true, '上游生图请求失败（HTTP 502）'),
  );
  await assert.rejects(controller.generate(tag, 'manual'));
  assert.equal(calls.generate.length, 6, '主线路限流自动换一次；备用线路也失败就停，不来回打转');
  assert.equal(calls.problems.at(-1).context.attempt.status, 'failed');
  assert.equal(calls.problems.at(-1).fallback, undefined);
});

test('失败卡片上的「换备用线路」；没设备用线路、NovelAI、增强模式时没有备用线路', async () => {
  const { store, controller, calls, api } = setup({
    preset: MAIN,
    presets: [MAIN, BACKUP],
    settings: { backupPresetId: 'stable' },
    generate: async input => ({ attemptId: input.attemptId, tagId: input.tagId, status: 'succeeded' }),
  });
  await controller.generateWithBackup(tag);
  assert.equal(calls.generate.at(-1).presetId, 'stable');

  store.set({ settings: { ...store.state.settings, backupPresetId: '' } });
  assert.equal(await controller.generateWithBackup(tag), undefined);
  store.set({ settings: { ...store.state.settings, backupPresetId: 'stable', generationProvider: 'novelai' } });
  assert.equal(await controller.generateWithBackup(tag), undefined);
  store.set({ settings: { ...store.state.settings, generationProvider: 'openai' } });
  api.mode = () => 'server';
  assert.equal(await controller.generateWithBackup(tag), undefined);
  assert.equal(calls.generate.length, 1);
});
