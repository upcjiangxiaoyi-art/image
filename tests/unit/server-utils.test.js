import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adapter = require('../../server-plugin/src/adapters/openai-images');
const { maskKey } = require('../../server-plugin/src/services/preset');
const { assertInside, detectImageType } = require('../../server-plugin/src/utils/validation');
const { atomicWriteJson, readJson } = require('../../server-plugin/src/utils/atomic-json');

test('URL join 不重复 /v1', async () => {
  const core = await adapter.loadCore();
  assert.equal(
    core.normalizeEndpoint('https://api.example.com', '/v1/images/generations'),
    'https://api.example.com/v1/images/generations',
  );
  assert.equal(
    core.normalizeEndpoint('https://api.example.com/v1', '/v1/images/generations'),
    'https://api.example.com/v1/images/generations',
  );
  assert.equal(
    core.normalizeEndpoint('https://api.example.com/v1/', '/images/generations'),
    'https://api.example.com/v1/images/generations',
  );
  const { normalizeImageSize } = await import('../../src/shared/openai-images-core.js');
  assert.equal(normalizeImageSize('1024×1536'), '1024x1536');
});

test('响应解析优先 Base64，并支持包裹层', async () => {
  const core = await adapter.loadCore();
  const result = core.parseImageResponse({
    result: { data: [{ url: 'https://x', b64_json: 'AAAA' }, { url: 'https://y' }] },
  });
  assert.equal(result[0].sourceType, 'base64');
  assert.equal(result[1].sourceType, 'url');
});

test('模型响应支持 data 与直接数组', async () => {
  const core = await adapter.loadCore();
  assert.deepEqual(core.parseModelsResponse({ data: [{ id: 'a', owned_by: 'x' }] }), [{ id: 'a', ownedBy: 'x' }]);
  assert.deepEqual(core.parseModelsResponse(['a']), [{ id: 'a' }]);
});

test('API Key 掩码不暴露完整值', () => {
  const masked = maskKey('sk-super-secret-abcd');
  assert.equal(masked, 'sk-••••abcd');
  assert.equal(masked.includes('super-secret'), false);
});

test('路径越界被阻止，PNG magic bytes 可识别', () => {
  const root = path.resolve('safe-root');
  assert.throws(
    () => assertInside(root, path.resolve(root, '..', 'outside')),
    error => error.code === 'VALIDATION_FAILED' && error.details === '文件路径越界',
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(detectImageType(png), { mimeType: 'image/png', extension: 'png' });
});

test('JSON 原子写入并保留上一版备份', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-atomic-'));
  const file = path.join(directory, 'index.json');
  const backup = path.join(directory, 'index.backup.json');
  await atomicWriteJson(file, { version: 1 }, { backupFile: backup });
  await atomicWriteJson(file, { version: 2 }, { backupFile: backup });
  assert.deepEqual(await readJson(file, {}), { version: 2 });
  assert.deepEqual(await readJson(backup, {}), { version: 1 });
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
});

test('Server Plugin 与直连共用同一份请求逻辑：unsafe 识别、200 里的报错原因、审核不重试，上游错误仍报 502', async t => {
  /* Server Plugin 用自己的 HTTP 客户端（不走 Node 自带 fetch），所以对着真的本地服务器测。 */
  let respond = (_request, response) => response.end();
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    request.resume();
    request.on('end', () => respond(request, response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const reply = (status, payload) => (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  const preset = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    generationPath: '/v1/images/generations',
    selectedModel: 'gpt-image-2.5-sunburst',
    sendSize: true,
    defaultSize: '1024x1024',
    sendQuality: true,
    defaultQuality: 'max',
    sendN: false,
    timeoutMs: 5000,
    extraBody: {},
  };
  const settings = { allowHttp: true };

  respond = reply(200, { error: { message: 'Generation failed: prompt is unsafe' } });
  await assert.rejects(
    adapter.generate({ preset, apiKey: 'sk-test', prompt: 'x', parameters: {}, settings }),
    error => error.code === 'UPSTREAM_RESPONSE_INVALID'
      && /上游没有返回图片：Generation failed: prompt is unsafe/.test(error.message)
      && /内容审核拒绝/.test(error.message),
  );

  calls = 0;
  respond = reply(400, { error: { message: 'unsafe prompt: size not allowed' } });
  await assert.rejects(
    adapter.generate({ preset, apiKey: 'sk-test', prompt: 'x', parameters: {}, settings: { ...settings, enableSmartRetry: true } }),
    error => error.code === 'UPSTREAM_HTTP_ERROR' && error.status === 502 && error.upstreamStatus === 400
      && /HTTP 400/.test(error.message),
  );
  assert.equal(calls, 1, '审核拦截即使点名了参数也不智能重试');

  const { AppError } = require('../../server-plugin/src/utils/errors');
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(
    adapter.generate({
      preset: { ...preset, baseUrl: `http://127.0.0.1:${closedPort}` },
      apiKey: 'sk-test',
      prompt: 'x',
      parameters: {},
      settings,
    }),
    error => error instanceof AppError && error.code === 'UPSTREAM_HTTP_ERROR' && error.status === 502,
    '连不上时仍报 502',
  );
});

test('Server Plugin 的 HTTP 客户端：读状态和正文、解压缩、不跟随跳转，可以随时取消', async t => {
  const { longFetch } = require('../../server-plugin/src/utils/long-fetch');
  const zlib = await import('node:zlib');
  let respond = (_request, response) => response.end();
  const server = http.createServer((request, response) => respond(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/v1/images/generations`;

  respond = (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ method: request.method, body, auth: request.headers.authorization }));
    });
  };
  const echoed = await longFetch(url, { method: 'POST', headers: { Authorization: 'Bearer sk-test' }, body: '{"n":1}' });
  assert.equal(echoed.ok, true);
  assert.equal(echoed.status, 201);
  assert.equal(echoed.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await echoed.json(), { method: 'POST', body: '{"n":1}', auth: 'Bearer sk-test' });

  respond = (_request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'gzip' });
    response.end(zlib.gzipSync('压缩过的正文'));
  };
  assert.equal(await (await longFetch(url)).text(), '压缩过的正文');

  respond = (_request, response) => {
    response.writeHead(302, { Location: 'https://example.com/' });
    response.end();
  };
  const redirected = await longFetch(url);
  assert.equal(redirected.status, 302, '不跟随跳转，和 redirect: \'error\' 一样交给调用方报错');
  assert.equal(redirected.ok, false);

  respond = () => {};
  const controller = new AbortController();
  const pending = longFetch(url, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('timeout')), 50);
  await assert.rejects(pending, /timeout/, '预设里的「超时」到了或用户取消时照常断开');
  await assert.rejects(longFetch(url, { signal: AbortSignal.abort() }), error => error.name === 'AbortError');
});
