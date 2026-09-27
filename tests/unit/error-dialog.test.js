import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DirectError, generateImages } from '../../src/ui/api/openai-direct.js';
import {
  createErrorDialog,
  describeGenerationProblem,
  requestedQuality,
} from '../../src/ui/pages/error-dialog/error-dialog.js';

function withDom(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });
  return dom;
}

function presetFor(extra = {}) {
  return {
    baseUrl: 'https://api.example.com',
    generationPath: '/v1/images/generations',
    selectedModel: 'gpt-image-2',
    sendSize: false,
    sendQuality: true,
    sendN: false,
    defaultQuality: 'auto',
    responseFormat: '',
    timeoutMs: 1000,
    extraBody: {},
    ...extra,
  };
}

function mockFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return handler(body, bodies.length);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return bodies;
}

const upstreamError = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status });
const OK = () => new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 });

async function failedGeneration(options) {
  try {
    await generateImages({ apiKey: 'sk', prompt: 'x', settings: {}, ...options });
  } catch (error) {
    return error;
  }
  return assert.fail('请求应当失败');
}

test('requestedQuality 与实际请求体里的 quality 一致', async t => {
  const bodies = mockFetch(t, OK);
  const cases = [
    [presetFor({ defaultQuality: 'high' }), undefined],
    [presetFor({ defaultQuality: 'high' }), 'max'],
    [presetFor({ defaultQuality: 'high', sendQuality: false }), 'max'],
    [presetFor({ sendQuality: false, extraBody: { quality: 'xhigh' } }), 'max'],
    [presetFor({ extraBody: { quality: 'max' } }), 'low'],
  ];
  for (const [preset, tagQuality] of cases) {
    await generateImages({
      preset, apiKey: 'sk', prompt: 'x', parameters: { quality: tagQuality }, settings: {},
    });
    assert.equal(
      requestedQuality({ preset, tagQuality }),
      bodies.at(-1).quality ?? '',
      JSON.stringify({ preset: { ...preset, baseUrl: undefined }, tagQuality }),
    );
  }
  assert.equal(requestedQuality({ provider: 'novelai', preset: presetFor(), tagQuality: 'max' }), '');
  assert.equal(requestedQuality({ preset: null, tagQuality: 'max' }), '');
});

test('quality=max 被上游 400 拒绝：弹窗带原始报错，并提示只有 gpt-image-2.5 支持', async t => {
  mockFetch(t, () => upstreamError(
    400,
    "Invalid value: 'max'. Supported values are: 'low', 'medium', 'high', and 'auto'.",
  ));
  const error = await failedGeneration({ preset: presetFor(), parameters: { quality: 'max' } });
  const problem = describeGenerationProblem({
    attempt: { status: 'failed', errorCode: error.code, errorMessage: error.message },
    error,
    quality: 'max',
  });
  assert.equal(problem.tone, 'danger');
  assert.equal(problem.title, '生成失败');
  assert.equal(problem.message, error.message, '上游原话已在报错里，不重复追加');
  assert.match(problem.message, /HTTP 400/);
  assert.match(problem.message, /Invalid value: 'max'/);
  assert.match(problem.hint, /quality 是 max/);
  assert.match(problem.hint, /gpt-image-2\.5-flare \/ gpt-image-2\.5-sunburst/);

  const serverSide = describeGenerationProblem({
    attempt: { status: 'failed', errorCode: 'UPSTREAM_HTTP_ERROR', errorMessage: error.message },
    quality: 'xhigh',
  });
  assert.match(serverSide.hint, /quality 是 xhigh/, '增强模式只有落盘的报错文本，也能识别 HTTP 400');
});

test('与 quality 无关的失败不提示 2.5 系列', async t => {
  let status = 429;
  mockFetch(t, () => upstreamError(status, 'rate limited'));
  const limited = await failedGeneration({ preset: presetFor(), parameters: { quality: 'max' } });
  assert.equal(describeGenerationProblem({ error: limited, quality: 'max' }).hint, '');

  status = 400;
  const rejected = await failedGeneration({ preset: presetFor(), parameters: { quality: 'high' } });
  assert.equal(describeGenerationProblem({ error: rejected, quality: 'high' }).hint, '', 'high 不提示');

  const blocked = new DirectError('DIRECT_FETCH_BLOCKED', 'Failed to fetch', 0, true);
  const offline = describeGenerationProblem({ error: blocked, quality: 'max' });
  assert.equal(offline.hint, '');
  assert.match(offline.message, /^浏览器连不上生图接口.*（Failed to fetch）$/);
});

test('失败弹窗沿用卡片上的报错，并补上卡片没显示的错误详情', () => {
  const error = new DirectError('VALIDATION_FAILED', 'NovelAI 宽高需为 64 的倍数，且不超过 2048');
  const problem = describeGenerationProblem({
    attempt: { status: 'failed', errorCode: error.code, errorMessage: error.message },
    error,
  });
  assert.equal(problem.message, '请求参数无效（NovelAI 宽高需为 64 的倍数，且不超过 2048）');

  const retried = describeGenerationProblem({
    attempt: {
      status: 'failed',
      errorCode: 'UPSTREAM_HTTP_ERROR',
      errorMessage: '上游生图请求失败（HTTP 400）：second failure；已尝试移除 quality 后重试一次',
    },
    error: new DirectError('UPSTREAM_HTTP_ERROR', 'second failure', 400),
  });
  assert.match(retried.message, /已尝试移除 quality 后重试一次$/, '落盘记录里的重试说明保留');
});

test('智能重试去掉 quality 才出图时提醒这张不是 max；只回退 response_format 不打扰', async t => {
  mockFetch(t, (_body, call) => (call === 1
    ? upstreamError(422, 'quality must be omitted because it is not supported')
    : OK()));
  const retries = [];
  await generateImages({
    preset: presetFor(),
    apiKey: 'sk',
    prompt: 'x',
    parameters: { quality: 'max' },
    settings: { enableSmartRetry: true },
    onCompatibilityRetry: retry => retries.push(retry),
  });
  const problem = describeGenerationProblem({
    attempt: { status: 'succeeded', compatibilityRetry: retries[0] },
    quality: 'max',
  });
  assert.equal(problem.tone, 'warning');
  assert.match(problem.message, /质量 quality/);
  assert.match(problem.message, /不是 quality=max/);
  assert.match(problem.hint, /gpt-image-2\.5-flare/);

  const sizeOnly = describeGenerationProblem({
    attempt: { status: 'succeeded', compatibilityRetry: { adjustedParameters: ['size', 'response_format'] } },
    quality: 'max',
  });
  assert.match(sizeOnly.message, /尺寸 size/);
  assert.equal(sizeOnly.message.includes('response_format'), false);
  assert.equal(sizeOnly.message.includes('不是 quality'), false);
  assert.equal(sizeOnly.hint, '');

  assert.equal(describeGenerationProblem({
    attempt: { status: 'succeeded', compatibilityRetry: { adjustedParameters: ['response_format'] } },
    quality: 'max',
  }), null);
  assert.equal(describeGenerationProblem({ attempt: { status: 'succeeded' }, quality: 'max' }), null);
  for (const status of ['cancelled', 'interrupted', 'generating']) {
    assert.equal(describeGenerationProblem({ attempt: { status, errorMessage: '已取消' } }), null, status);
  }
});

test('报错弹窗：同内容计次、不同内容追加，知道了 / Esc / 点遮罩都能关', t => {
  const dom = withDom(t);
  const dialog = createErrorDialog();
  const panel = dialog.root.querySelector('[role="alertdialog"]');
  const items = () => dialog.root.querySelectorAll('.stia-error-dialog__item');
  assert.equal(dialog.root.hidden, true);

  const failure = { tone: 'danger', title: '生成失败', message: 'HTTP 400：bad quality', hint: '改回 high' };
  dialog.show(failure);
  assert.equal(dialog.root.hidden, false);
  assert.equal(panel.getAttribute('aria-label'), '生成失败');
  assert.match(dialog.root.textContent, /HTTP 400：bad quality/);
  assert.match(dialog.root.textContent, /改回 high/);
  assert.equal(document.activeElement.textContent, '知道了');

  dialog.show(failure);
  assert.equal(items().length, 1);
  assert.match(dialog.root.textContent, /生成失败（×2）/);

  dialog.show({ tone: 'warning', title: '参数被上游拒绝，已自动回退', message: 'quality 已去掉', hint: '' });
  assert.equal(items().length, 2);
  assert.match(panel.getAttribute('aria-label'), /2 条生图提醒/);
  assert.equal(panel.dataset.tone, 'danger', '有失败时整体按失败显示');

  [...dialog.root.querySelectorAll('button')].find(button => button.textContent === '知道了').click();
  assert.equal(dialog.root.hidden, true);
  assert.equal(items().length, 0, '关掉后清空，下次只显示新提醒');

  dialog.show({ tone: 'warning', title: '参数被上游拒绝，已自动回退', message: 'size 已去掉' });
  assert.equal(panel.dataset.tone, 'warning');
  let escapesBelow = 0;
  document.addEventListener('keydown', () => { escapesBelow += 1; });
  document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dialog.root.hidden, true);
  assert.equal(escapesBelow, 0, 'Esc 只关弹窗，不连带关掉下面的设置窗口');

  dialog.show(failure);
  dialog.root.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.root.hidden, true);

  dialog.show({ tone: 'danger', title: '生成失败' });
  assert.equal(dialog.root.hidden, true, '没有报错内容时不弹');
});
