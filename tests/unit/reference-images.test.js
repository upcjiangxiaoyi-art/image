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

test('带参考图走 /v1/images/edits：两张用 image[]、一张用 image；response_format 照预设发；高保真发 input_fidelity', async () => {
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
  /* 2.8.1 之前模型名以 gpt-image 开头就不发 response_format（官方接口这类模型只回 base64）。
     中转不一定：有的渠道不说要 b64_json 就只回一个链接，浏览器下载不了，图画好了却丢了。 */
  assert.equal(body.get('response_format'), 'b64_json', '模型名是 gpt-image 开头也照预设要 b64_json');
  assert.equal(body.get('input_fidelity'), 'high');
  assert.equal(calls[0].options.headers['Content-Type'], undefined, '边界由浏览器填，不自己写 Content-Type');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');

  await generate(core, { references: [references[0]] });
  const single = calls[1].options.body;
  assert.ok(single.get('image') instanceof Blob, '一张用 image');
  assert.equal(single.getAll('image[]').length, 0);
  assert.equal(single.get('input_fidelity'), null, '没开高保真不发');

  await generate(core, { preset: { ...preset, selectedModel: 'dall-e-2', responseFormat: 'url' }, references: [references[0]] });
  assert.equal(calls[2].options.body.get('response_format'), 'url', '预设选了 url 就发 url');
  await generate(core, { preset: { ...preset, responseFormat: '' }, references: [references[0]] });
  assert.equal(calls[3].options.body.get('response_format'), null, '预设选了「不发送」就不发');
  calls.splice(3, 1);

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

/* 2.8.1 图生图里的 response_format 是画笺照预设加上的；线路点名说不认，就去掉重发，不看「智能重试」开没开，
   也不占智能重试那一次。别的参数被拒照旧看开关。 */
const reference = [{ bytes: png, mimeType: 'image/png', name: 'a.png' }];
const ok = () => json(200, { data: [{ b64_json: 'A'.repeat(80) }] });
const rejectFormat = () => json(400, { error: { message: "Unknown parameter: 'response_format'." } });
const rejectFidelity = () => json(400, { error: { message: '当前服务尚未接入 input_fidelity 参数' } });
const fidelityPreset = { ...preset, referenceFidelity: 'high' };

test('图生图：线路点名不认 response_format，没开智能重试也去掉重发一次；别的参数被拒照旧看开关', async () => {
  /* 官方接口那样的线路：gpt-image 的图生图不收 response_format。 */
  let run = setup(async (url, options) => (options.body.get('response_format') ? rejectFormat() : ok()));
  const retries = [];
  let sources = await generate(run.core, { references: reference, onCompatibilityRetry: retry => retries.push(retry) });
  assert.equal(sources.length, 1);
  assert.equal(run.calls.length, 2, '带着被拒一次，去掉再发一次');
  assert.equal(run.calls[0].options.body.get('response_format'), 'b64_json');
  assert.equal(run.calls[1].options.body.get('response_format'), null);
  assert.ok(run.calls[1].options.body.get('image') instanceof Blob, '参考图照带');
  assert.equal(run.calls[1].options.body.get('quality'), 'high', '别的参数不动');
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0].adjustedParameters, ['response_format']);
  assert.equal(retries[0].message, '这条线路不认 response_format 参数，已去掉，正在重试（1/1）');

  /* 中转把上游的话包成自己的 500、也没写 status_code：点名了 response_format 就认。 */
  run = setup(async (url, options) => (options.body.get('response_format')
    ? json(500, { error: { message: 'upstream error: unknown parameter response_format' } })
    : ok()));
  sources = await generate(run.core, { references: reference });
  assert.equal(run.calls.length, 2);

  /* 没开智能重试：quality 被拒照旧直接报错，不重发。 */
  run = setup(async () => json(400, { error: { message: "Unsupported parameter: 'quality'" } }));
  await assert.rejects(generate(run.core, { references: reference }), error => /quality/.test(error.details));
  assert.equal(run.calls.length, 1);

  /* 没开智能重试、线路两个都不认：response_format 去掉重发，又被 input_fidelity 拦住，就报这个。 */
  run = setup(async (url, options) => {
    if (options.body.get('response_format')) return rejectFormat();
    return options.body.get('input_fidelity') ? rejectFidelity() : ok();
  });
  await assert.rejects(
    generate(run.core, { preset: fidelityPreset, references: reference }),
    error => /input_fidelity/.test(error.details) && error.compatibilityRetry.adjustedParameters.join() === 'response_format',
  );
  assert.equal(run.calls.length, 2);

  /* 审核、余额这类原因里碰巧提到 response_format：不重发。 */
  run = setup(async () => json(400, { error: { message: 'insufficient quota; response_format is not supported on free tier' } }));
  await assert.rejects(generate(run.core, { references: reference }));
  assert.equal(run.calls.length, 1);
  /* 401、404、429 这些不是「参数被拒」。 */
  for (const status of [401, 404, 429]) {
    run = setup(async () => json(status, { error: { message: 'unknown parameter response_format' } }));
    await assert.rejects(generate(run.core, { references: reference }));
    assert.equal(run.calls.length, 1, `HTTP ${status}`);
  }

  /* 放宽只放给 response_format：普通的 500 里同时点了别的参数的名，别的不算（上游可能已经开始画了）。 */
  const plain500 = new TestError('UPSTREAM_HTTP_ERROR', 'unknown parameters: response_format, quality', 500);
  const sent = { response_format: 'b64_json', quality: 'high' };
  assert.equal(run.core.detectCompatibilityRetry(plain500, sent), null, '不放宽时普通 500 不重试');
  assert.deepEqual(run.core.detectCompatibilityRetry(plain500, sent, { named5xx: ['response_format'] }).adjustedParameters, ['response_format']);
  const wrapped400 = new TestError('UPSTREAM_HTTP_ERROR', 'status_code=400, unknown parameters: response_format, quality', 500);
  assert.deepEqual(
    run.core.detectCompatibilityRetry(wrapped400, sent, { named5xx: ['response_format'] }).adjustedParameters,
    ['response_format', 'quality'],
    '写明上游是 400 的照旧都算',
  );

  /* 没有参考图的普通生图不变：没开智能重试，response_format 被拒就照原样报错。 */
  run = setup(async () => rejectFormat());
  await assert.rejects(generate(run.core, {}), error => /response_format/.test(error.details));
  assert.equal(run.calls.length, 1);
});

test('图生图：开着智能重试时，去掉 response_format 不占那一次——线路两个参数都不认，第一张也画得成，最多发三次', async () => {
  const bothRejected = first => async (url, options) => {
    const format = options.body.get('response_format');
    const fidelity = options.body.get('input_fidelity');
    if (first === 'format' && format) return rejectFormat();
    if (fidelity) return rejectFidelity();
    if (format) return rejectFormat();
    return ok();
  };
  for (const first of ['format', 'fidelity']) {
    const run = setup(bothRejected(first));
    const retries = [];
    const sources = await generate(run.core, {
      preset: fidelityPreset,
      settings: { enableSmartRetry: true },
      references: reference,
      onCompatibilityRetry: retry => retries.push(retry),
    });
    assert.equal(sources.length, 1, first);
    assert.equal(run.calls.length, 3, `${first}：带着两个、去掉一个、两个都去掉`);
    assert.equal(run.calls[2].options.body.get('response_format'), null);
    assert.equal(run.calls[2].options.body.get('input_fidelity'), null);
    assert.equal(retries.length, 2);
    assert.deepEqual([...retries[1].adjustedParameters].sort(), ['input_fidelity', 'response_format'], '第二次说的是到现在一共去掉了哪些');
    assert.match(retries[1].message, /^这条线路不认 .+、.+ 参数，已去掉，正在重试（2\/2）$/);
  }

  /* 一句报错里两个都点了名：一次去掉两个。 */
  let run = setup(async (url, options) => (options.body.get('response_format') || options.body.get('input_fidelity')
    ? json(400, { error: { message: 'Unknown parameters: response_format, input_fidelity' } })
    : ok()));
  await generate(run.core, { preset: fidelityPreset, settings: { enableSmartRetry: true }, references: reference });
  assert.equal(run.calls.length, 2);

  /* 智能重试还是只有一次：quality、input_fidelity 先后被拒，第二个不再重发。 */
  run = setup(async (url, options) => {
    if (options.body.get('quality')) return json(400, { error: { message: "Unsupported parameter: 'quality'" } });
    return options.body.get('input_fidelity') ? rejectFidelity() : ok();
  });
  await assert.rejects(
    generate(run.core, { preset: { ...fidelityPreset, responseFormat: '' }, settings: { enableSmartRetry: true }, references: reference }),
    error => /input_fidelity/.test(error.details),
  );
  assert.equal(run.calls.length, 2);

  /* 去掉之后线路还在说 response_format：不会一直发下去。 */
  run = setup(async () => rejectFormat());
  await assert.rejects(generate(run.core, { settings: { enableSmartRetry: true }, references: reference }));
  assert.equal(run.calls.length, 2);
});
