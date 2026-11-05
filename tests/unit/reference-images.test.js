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
