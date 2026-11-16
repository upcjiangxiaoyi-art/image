import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiImagesCore } from '../../src/shared/openai-images-core.js';

/* 1.8.0 参考图（图生图）：带图时走 /v1/images/edits 的 multipart 表单。 */
class TestError extends Error {
  constructor(code, details = '', status = 400, retryable = false, publicMessage = '') {
    super(publicMessage || code);
    this.code = code;
    this.details = details;
    this.status = status;
    this.retryable = retryable;
  }
}
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const preset = {
  baseUrl: 'https://relay.test',
  generationPath: '/v1/images/generations',
  editsPath: '/v1/images/edits',
  selectedModel: 'gpt-image-1',
  sendSize: true,
  defaultSize: '1024x1024',
  sendQuality: true,
  defaultQuality: 'high',
  sendN: true,
  defaultCount: 1,
  responseFormat: 'b64_json',
  timeoutMs: 3000,
  extraBody: {},
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(handler) {
  const calls = [];
  const core = createOpenAiImagesCore({
    ErrorClass: TestError,
    networkError: error => new TestError('DIRECT_FETCH_BLOCKED', error?.message || 'Failed to fetch', 0, true),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return handler(String(url), options, calls.length);
    },
    asyncPollIntervalMs: 5,
  });
  return { core, calls };
}
const generate = (core, extra = {}) => core.generateImages({ preset, apiKey: 'sk-test', prompt: 'cat', parameters: {}, settings: {}, ...extra });

test('带参考图走 /v1/images/edits：两张用 image[]、一张用 image；gpt-image 不发 response_format；高保真发 input_fidelity', async () => {
  const { core, calls } = setup(async () => json(200, { data: [{ b64_json: 'A'.repeat(80) }] }));
  const references = [
    { bytes: png, mimeType: 'image/png', name: 'a.png' },
    { blob: new Blob([png], { type: 'image/png' }), name: 'b.png' },
  ];
  const sources = await generate(core, { preset: { ...preset, referenceFidelity: 'high' }, parameters: { size: '1024x1536' }, references });
  assert.equal(sources[0].sourceType, 'base64');
  assert.equal(calls[0].url, 'https://relay.test/v1/images/edits');
  const body = calls[0].options.body;
  assert.ok(body instanceof FormData, '多部分表单');
  assert.equal(body.getAll('image[]').length, 2);
  assert.ok(body.getAll('image[]')[0] instanceof Blob);
  assert.equal(body.get('prompt'), 'cat');
  assert.equal(body.get('model'), 'gpt-image-1');
  assert.equal(body.get('size'), '1024x1536');
  assert.equal(body.get('quality'), 'high');
  assert.equal(body.get('n'), '1');
  assert.equal(body.get('response_format'), null, 'gpt-image 的 edits 不收 response_format');
  assert.equal(body.get('input_fidelity'), 'high');
  assert.equal(calls[0].options.headers['Content-Type'], undefined, '边界由浏览器填，不自己写 Content-Type');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');

  await generate(core, { references: [references[0]] });
  const single = calls[1].options.body;
  assert.ok(single.get('image') instanceof Blob, '一张用 image');
  assert.equal(single.getAll('image[]').length, 0);
  assert.equal(single.get('input_fidelity'), null, '没开高保真不发');

  await generate(core, { preset: { ...preset, selectedModel: 'dall-e-2', responseFormat: 'url' }, references: [references[0]] });
  assert.equal(calls[2].options.body.get('response_format'), 'url', 'dall-e-2 才收 response_format');

  await generate(core, { references: [] });
  assert.equal(calls[3].url, 'https://relay.test/v1/images/generations', '没有参考图照旧走普通接口');
  assert.equal(typeof calls[3].options.body, 'string');
  assert.equal(calls[3].options.headers['Content-Type'], 'application/json');
});

test('图生图也能智能重试：上游点名 quality 不支持，第二次表单里就没有 quality，图照带', async () => {
  const { core, calls } = setup(async (url, options, index) => (index === 1
    ? json(400, { error: { message: "Unsupported parameter: 'quality'" } })
    : json(200, { data: [{ b64_json: 'A'.repeat(80) }] })));
  const retries = [];
  const sources = await generate(core, {
    settings: { enableSmartRetry: true },
    references: [{ bytes: png, mimeType: 'image/png', name: 'a.png' }],
    onCompatibilityRetry: retry => retries.push(retry),
  });
  assert.equal(sources.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(retries[0].adjustedParameters, ['quality']);
  assert.equal(calls[0].options.body.get('quality'), 'high');
  assert.equal(calls[1].options.body.get('quality'), null);
  assert.ok(calls[1].options.body.get('image') instanceof Blob, '重试时参考图照带');
});

/* 2.5.2 线路不认高保真参考：中转回「当前服务尚未接入 input_fidelity 参数」。 */
test('线路回「尚未接入 input_fidelity 参数」：智能重试开着时去掉它重发一次，参考图和别的参数照带；关着时原样报错', async () => {
  const rejecting = async (url, options) => (options.body.get('input_fidelity')
    ? json(400, { error: { message: 'status_code=400, 当前服务尚未接入 input_fidelity 参数' } })
    : json(200, { data: [{ b64_json: 'A'.repeat(80) }] }));
  const withFidelity = { ...preset, referenceFidelity: 'high' };
  const references = [{ bytes: png, mimeType: 'image/png', name: 'a.png' }];

  const on = setup(rejecting);
  const retries = [];
  const sources = await generate(on.core, {
    preset: withFidelity,
    settings: { enableSmartRetry: true },
    references,
    onCompatibilityRetry: retry => retries.push(retry),
  });
  assert.equal(sources.length, 1);
  assert.equal(on.calls.length, 2, '第一次被拒，去掉 input_fidelity 重发一次');
  assert.deepEqual(retries[0].adjustedParameters, ['input_fidelity']);
  assert.equal(on.calls[0].options.body.get('input_fidelity'), 'high');
  assert.equal(on.calls[1].options.body.get('input_fidelity'), null);
  assert.equal(on.calls[1].options.body.get('quality'), 'high', '别的参数不动');
  assert.ok(on.calls[1].options.body.get('image') instanceof Blob, '参考图照带');

  const off = setup(rejecting);
  await assert.rejects(
    generate(off.core, { preset: withFidelity, references }),
    error => error.code === 'UPSTREAM_HTTP_ERROR' && /input_fidelity/.test(error.details),
  );
  assert.equal(off.calls.length, 1, '没开智能重试就不重发');
});

test('认得出「线路不认这个参数」的各种说法；没点名参数、根本没发过、余额不足、普通 5xx 都不重试', () => {
  const { core } = setup(async () => json(200, {}));
  const detect = (status, details, body = { input_fidelity: 'high', quality: 'high' }) => {
    const error = new TestError('UPSTREAM_HTTP_ERROR', details, status);
    return core.detectCompatibilityRetry(error, body)?.adjustedParameters || null;
  };
  for (const details of [
    '当前服务尚未接入 input_fidelity 参数',
    'status_code=400, 当前服务尚未接入 input_fidelity 参数',
    'input_fidelity 参数未接入',
    '该分组暂未支持 input_fidelity',
    '暂不支持 input_fidelity 参数',
    "The parameter 'input_fidelity' is not implemented for this model",
    'This model does not support input_fidelity',
    'input fidelity is not available on this deployment',
    '该渠道不支持高保真参数',
  ]) {
    assert.deepEqual(detect(400, details), ['input_fidelity'], details);
  }
  assert.deepEqual(detect(422, '当前服务尚未接入 input_fidelity 参数'), ['input_fidelity']);
  assert.deepEqual(
    detect(500, 'status_code=400, 当前服务尚未接入 input_fidelity 参数'),
    ['input_fidelity'],
    '中转把上游的 400 包成 500，正文里写着 status_code=400：也认',
  );
  assert.equal(detect(500, '当前服务尚未接入 input_fidelity 参数'), null, '普通的 5xx 不重试：上游可能已经开始画了');
  assert.equal(detect(502, 'status_code=502, upstream error, input_fidelity unsupported'), null);
  assert.equal(detect(400, '当前服务尚未接入 input_fidelity 参数', { quality: 'high' }), null, '根本没发过这个参数');
  assert.equal(detect(400, '当前服务尚未接入 gpt-image-2 模型'), null, '没点名任何参数');
  assert.equal(detect(400, '余额不足，且尚未接入 input_fidelity 参数'), null, '余额问题重试也没用');
  assert.equal(detect(400, 'input_fidelity 触发内容审核'), null);
});
