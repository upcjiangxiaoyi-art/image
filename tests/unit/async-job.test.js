import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiImagesCore } from '../../src/shared/openai-images-core.js';

/* 1.7.4：有的中转把生图接口做成异步任务，第一次只回任务记录，要拿着 id 轮询。 */
class TestError extends Error {
  constructor(code, details = '', status = 400, retryable = false, publicMessage = '') {
    super(publicMessage || code);
    this.code = code;
    this.details = details;
    this.status = status;
    this.retryable = retryable;
  }
}

const preset = {
  baseUrl: 'https://relay.test',
  generationPath: '/v1/images/generations',
  selectedModel: 'gpt-image-1',
  sendSize: false,
  sendQuality: false,
  sendN: false,
  responseFormat: 'b64_json',
  timeoutMs: 3000,
  extraBody: {},
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const job = (extra = {}) => ({
  assets: [], attempt: 1, auto_poll: true, batch_id: '', billed_amount: 0, charged_amount: 0, client_dropped: false,
  client_request_id: '', created_at: '2026-11-03T17:41:19+08:00', currency: 'USD', endpoint: '/v1/images/generations',
  error: '', error_code: '', error_stage: '', execution_mode: 'async', id: 'job-1', status: 'pending', ...extra,
});

function setup(handler, options = {}) {
  const calls = [];
  const core = createOpenAiImagesCore({
    ErrorClass: TestError,
    networkError: error => new TestError('DIRECT_FETCH_BLOCKED', error?.message || 'Failed to fetch', 0, true),
    fetchImpl: async (url, requestOptions = {}) => {
      calls.push({ url: String(url), method: requestOptions.method || 'GET', headers: requestOptions.headers || {} });
      return handler(String(url), requestOptions, calls.length);
    },
    asyncPollIntervalMs: 5,
    ...options,
  });
  return { core, calls };
}

const generate = (core, extra = {}) => core.generateImages({ preset, apiKey: 'sk-test', prompt: 'cat', parameters: {}, settings: {}, ...extra });

test('第一次只回任务记录：拿着 id 去轮询（生图地址/任务 id），画完了在 assets 里给图', async () => {
  const seen = [];
  const { core, calls } = setup((url, options, index) => {
    if (options.method === 'POST') return json(200, job());
    if (url === 'https://relay.test/v1/images/generations/job-1') {
      return json(200, index < 4
        ? job({ status: 'processing' })
        : job({ status: 'completed', assets: [{ url: 'https://cdn.test/a.png' }] }));
    }
    throw new Error(`意外的请求：${url}`);
  });
  const sources = await generate(core, { onAsyncJob: value => seen.push(value) });
  assert.deepEqual(sources, [{ sourceType: 'url', value: 'https://cdn.test/a.png', generationIndex: 0 }]);
  assert.deepEqual(seen, [{ id: 'job-1', pollUrl: 'https://relay.test/v1/images/generations/job-1', status: 'pending' }], '卡片上说一声');
  assert.equal(calls.filter(call => call.method === 'GET').length, 3, '问了三次才画完');
  assert.equal(calls[1].headers.Authorization, 'Bearer sk-test', '轮询也带 Key');
});

test('给了 poll_url 就用它（相对地址按生图地址补全）；assets 直接是链接数组也认', async () => {
  const { core, calls } = setup((url, options) => {
    if (options.method === 'POST') return json(200, { request_id: 'r-9', status: 'queued', poll_url: '/v1/tasks/r-9' });
    if (url === 'https://relay.test/v1/tasks/r-9') return json(200, { status: 'done', assets: ['https://cdn.test/b.png'] });
    throw new Error(`意外的请求：${url}`);
  });
  const sources = await generate(core);
  assert.deepEqual(sources, [{ sourceType: 'url', value: 'https://cdn.test/b.png', generationIndex: 0 }]);
  assert.equal(calls[1].url, 'https://relay.test/v1/tasks/r-9');
});

test('任务失败：带审核字样的照审核提示，别的照原因说', async () => {
  const { core } = setup((url, options) => (options.method === 'POST'
    ? json(200, job())
    : json(200, job({ status: 'failed', error: 'content moderation rejected the prompt' }))));
  await assert.rejects(generate(core), error => error.code === 'UPSTREAM_RESPONSE_INVALID'
    && /异步任务失败：content moderation rejected/.test(error.message)
    && /审核/.test(error.message));
  const { core: plain } = setup((url, options) => (options.method === 'POST'
    ? json(200, job({ error_code: 'E_BUSY', error_stage: 'queue' }))
    : json(200, {})));
  await assert.rejects(generate(plain), error => /异步任务失败：E_BUSY queue/.test(error.message));
});

test('轮询地址猜错（404）：报错里带上第一次收到的字段，并建议站子改同步或给轮询地址', async () => {
  const { core } = setup((url, options) => (options.method === 'POST'
    ? json(200, job())
    : json(404, { error: { message: 'no such route' } })));
  await assert.rejects(generate(core), error => error.code === 'UPSTREAM_RESPONSE_INVALID'
    && /轮询任务状态失败/.test(error.message)
    && /HTTP 404/.test(error.message)
    && /顶层字段 assets、attempt、auto_poll/.test(error.message)
    && /同步返回，或提供轮询地址/.test(error.message));
});

test('等到预设超时还没画完就报超时，带最后一次状态', async () => {
  const { core } = setup((url, options) => (options.method === 'POST' ? json(200, job()) : json(200, job({ status: 'processing', progress: 42 }))));
  await assert.rejects(
    core.generateImages({ preset: { ...preset, timeoutMs: 40 }, apiKey: 'sk-test', prompt: 'cat', parameters: {}, settings: {} }),
    error => error.code === 'UPSTREAM_TIMEOUT' && /异步任务超时/.test(error.details) && /"progress":42/.test(error.details),
  );
});

test('同步返回不受影响，不多问一次；像任务又没有 id 和轮询地址的照旧报「没有图片数组」', async () => {
  const { core, calls } = setup((url, options) => (options.method === 'POST' ? json(200, { data: [{ b64_json: 'A'.repeat(80) }] }) : json(500, {})));
  const sources = await generate(core);
  assert.equal(sources[0].sourceType, 'base64');
  assert.equal(calls.length, 1, '没有轮询');
  const { core: vague, calls: vagueCalls } = setup((url, options) => (options.method === 'POST' ? json(200, { assets: [], execution_mode: 'async' }) : json(500, {})));
  await assert.rejects(generate(vague), error => /响应中没有图片数组/.test(error.details));
  assert.equal(vagueCalls.length, 1);
  assert.equal(core.asyncJobOf({ status: 'processing', task_id: 7 }, 'https://relay.test/v1/images/generations').pollUrl, 'https://relay.test/v1/images/generations/7');
  assert.equal(core.asyncJobOf({ status: 'processing' }, 'https://relay.test/x'), null, '没有 id 不猜');
  assert.equal(core.asyncJobOf({ id: 'x', data: [] }, 'https://relay.test/x'), null, '看不出是异步任务不轮询');
});

test('轮询途中取消：马上停下，不再问', async () => {
  const controller = new AbortController();
  let gets = 0;
  const { core } = setup((url, options) => {
    if (options.method === 'POST') return json(200, job());
    gets += 1;
    if (gets === 1) controller.abort(new Error('cancelled'));
    return json(200, job({ status: 'processing' }));
  });
  await assert.rejects(generate(core, { signal: controller.signal }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(gets, 1, '取消后不再轮询');
});
