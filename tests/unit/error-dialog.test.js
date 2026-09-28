import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DirectError, generateImages } from '../../src/ui/api/openai-direct.js';
import { createApiClient } from '../../src/ui/api/client.js';
import { createGalleryPage } from '../../src/ui/pages/gallery/gallery.js';
import {
  createErrorDialog,
  describeError,
  describeGenerationProblem,
  requestedQuality,
} from '../../src/ui/pages/error-dialog/error-dialog.js';

function withDom(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tavern.example/' });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
  };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
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
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    bodies.push(body);
    return handler(body, bodies.length, url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return bodies;
}

const json = (status, payload) => new Response(JSON.stringify(payload), { status });
const upstreamError = (status, message) => json(status, { error: { message } });
const OK = () => json(200, { data: [{ b64_json: 'AAAA' }] });

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

test('连不上、超时、审核拦截（含 HTTP 200 里的 unsafe）、鉴权、限流、5xx 都弹，标题直接说是哪类', async t => {
  let respond;
  mockFetch(t, (_body, _call, _url, options) => respond(options));
  const hang = options => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const cases = [
    ['连不上服务器', () => { throw new TypeError('Failed to fetch'); }, /浏览器连不上生图接口/],
    ['请求超时', hang, /请求超时/],
    ['内容被审核拦截', () => upstreamError(400, 'Your request was rejected as a result of our safety system.'), /safety system/],
    ['内容被审核拦截', () => json(200, { error: { message: 'Generation failed: prompt is unsafe' } }), /上游没有返回图片：Generation failed: prompt is unsafe/],
    ['内容被审核拦截', () => json(200, { code: 1, msg: '提示词包含违规内容' }), /违规内容/],
    ['密钥或权限有问题', () => upstreamError(401, 'invalid api key'), /HTTP 401/],
    ['请求太频繁，被限流了', () => upstreamError(429, 'rate limited'), /HTTP 429/],
    ['上游服务器出错', () => upstreamError(502, 'bad gateway'), /HTTP 502/],
    ['请求超时', () => upstreamError(504, 'gateway timeout'), /HTTP 504/],
  ];
  for (const [title, handler, pattern] of cases) {
    respond = handler;
    const error = await failedGeneration({
      preset: presetFor({ timeoutMs: 30 }),
      parameters: { quality: 'max' },
    });
    const problem = describeGenerationProblem({
      attempt: { status: 'failed', errorCode: error.code, errorMessage: error.message },
      error,
      quality: 'max',
    });
    assert.equal(problem.title, title, `${title}: ${problem.message}`);
    assert.match(problem.message, pattern);
    assert.equal(problem.hint, '', `${title} 与 quality 无关，不提示 2.5 系列`);
  }
});

test('审核拦截的报错即使点名了参数也绝不智能重试', async t => {
  for (const message of ['unsafe prompt: quality not allowed', '内容违规：size 不允许', 'NSFW content, n is invalid']) {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return upstreamError(400, message);
    };
    try {
      const error = await failedGeneration({
        preset: presetFor({ sendSize: true, defaultSize: '1024x1024', sendN: true, defaultCount: 1 }),
        parameters: { quality: 'max' },
        settings: { enableSmartRetry: true },
      });
      assert.match(error.message, /内容审核拒绝/, message);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 1, message);
  }
});

test('失败弹窗沿用卡片上的报错，并补上卡片没显示的错误详情；中断也弹', () => {
  const error = new DirectError('VALIDATION_FAILED', 'NovelAI 宽高需为 64 的倍数，且不超过 2048');
  const problem = describeGenerationProblem({
    attempt: { status: 'failed', errorCode: error.code, errorMessage: error.message },
    error,
  });
  assert.equal(problem.title, '生成失败');
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

  const interrupted = describeGenerationProblem({
    attempt: { status: 'interrupted', errorCode: 'ATTEMPT_INTERRUPTED', errorMessage: '服务重启，原生成任务已中断' },
  });
  assert.equal(interrupted.title, '生成被中断');
  assert.equal(interrupted.message, '服务重启，原生成任务已中断');

  const downloadBlocked = describeGenerationProblem({
    error: new DirectError('DIRECT_FETCH_BLOCKED', 'Failed to fetch', 0, true, '生图成功了，但浏览器下载不了上游返回的图片'),
  });
  assert.equal(downloadBlocked.title, '图片下载失败', '生图成功只是下载不了，不说成连不上服务器');
});

test('生图以外的报错也能描述：按类别起标题，其余用调用方给的标题', () => {
  assert.equal(describeError(null), null);
  assert.deepEqual(describeError(new Error('额外请求参数不是有效 JSON'), '保存预设失败'), {
    tone: 'danger',
    title: '保存预设失败',
    message: '额外请求参数不是有效 JSON',
    hint: '',
  });
  const unavailable = describeError(Object.assign(new Error('服务端插件不可用，请确认已启用 Server Plugins 并重启 SillyTavern'), {
    code: 'SERVER_PLUGIN_UNAVAILABLE',
    status: 503,
  }), '画笺服务出错');
  assert.equal(unavailable.title, '连不上服务器');
  const missingKey = describeError(new DirectError('API_KEY_MISSING'), '测试模型接口失败');
  assert.equal(missingKey.title, '接口还没配置好');
  assert.equal(missingKey.message, '缺少 API 密钥');
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
  for (const status of ['cancelled', 'generating', 'queued']) {
    assert.equal(describeGenerationProblem({ attempt: { status, errorMessage: '已取消' } }), null, status);
  }
});

test('报错弹窗：点一下任意位置就关，选中文字时不关；同内容计次、不同内容合并', t => {
  const dom = withDom(t);
  const outside = document.createElement('textarea');
  document.body.append(outside);
  outside.focus();
  const dialog = createErrorDialog();
  const panel = dialog.root.querySelector('[role="alertdialog"]');
  const items = () => dialog.root.querySelectorAll('.stia-error-dialog__item');
  const click = target => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.root.hidden, true);
  assert.equal(dialog.root.querySelector('button'), null, '没有按钮，整个弹窗点一下就关');

  const failure = { tone: 'danger', title: '连不上服务器', message: '浏览器连不上生图接口', hint: '检查网络' };
  dialog.show(failure);
  assert.equal(dialog.root.hidden, false);
  assert.equal(panel.getAttribute('aria-label'), '连不上服务器');
  assert.match(dialog.root.textContent, /浏览器连不上生图接口/);
  assert.match(dialog.root.textContent, /检查网络/);
  assert.match(dialog.root.textContent, /点一下关闭/);
  assert.equal(document.activeElement, panel, '打开时焦点移到弹窗，读屏和键盘都能用');

  dialog.show(failure);
  assert.equal(items().length, 1);
  assert.match(dialog.root.textContent, /连不上服务器（×2）/);
  dialog.show({ tone: 'warning', title: '参数被上游拒绝，已自动回退', message: 'quality 已去掉', hint: '' });
  assert.equal(items().length, 2);
  assert.match(panel.getAttribute('aria-label'), /2 条报错/);
  assert.equal(panel.dataset.tone, 'danger', '有失败时整体按失败显示');

  const message = dialog.root.querySelector('.stia-error-dialog__message');
  const range = document.createRange();
  range.selectNodeContents(message);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  click(message);
  assert.equal(dialog.root.hidden, false, '选中报错文字想复制时不关');
  document.getSelection().removeAllRanges();

  click(message);
  assert.equal(dialog.root.hidden, true, '点弹窗里的文字就关');
  assert.equal(items().length, 0, '关掉后清空，下次只显示新报错');
  assert.equal(document.activeElement, outside, '关掉后焦点回到原来的位置');

  dialog.show(failure);
  click(dialog.root);
  assert.equal(dialog.root.hidden, true, '点空白处也关');

  dialog.show(failure);
  panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(dialog.root.hidden, true, '键盘 Enter 也能关');

  dialog.show({ tone: 'warning', title: '参数被上游拒绝，已自动回退', message: 'size 已去掉' });
  assert.equal(panel.dataset.tone, 'warning');
  let escapesBelow = 0;
  document.addEventListener('keydown', () => { escapesBelow += 1; });
  document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dialog.root.hidden, true);
  assert.equal(escapesBelow, 0, 'Esc 只关弹窗，不连带关掉下面的设置窗口');

  dialog.show({ tone: 'danger', title: '生成失败' });
  assert.equal(dialog.root.hidden, true, '没有报错内容时不弹');
});

test('生图失败那条带「重新生成」：点了只收起这一条并重跑，合并的几张一起重跑；点别处只关不重跑', t => {
  const dom = withDom(t);
  const dialog = createErrorDialog();
  const panel = dialog.root.querySelector('[role="alertdialog"]');
  const items = () => dialog.root.querySelectorAll('.stia-error-dialog__item');
  const retryButtons = () => [...dialog.root.querySelectorAll('.stia-error-dialog__retry')];
  const runs = [];
  const retryFor = key => ({
    key,
    run: () => {
      runs.push(key);
      return Promise.reject(new Error('重跑又失败了，会由生图流程自己再弹'));
    },
  });
  const timeout = { tone: 'danger', title: '请求超时', message: '请求超时' };

  dialog.show({ ...timeout, retry: retryFor('tag-a') });
  dialog.show({ ...timeout, retry: retryFor('tag-b') });
  dialog.show({ ...timeout, retry: retryFor('tag-a') });
  dialog.show({ tone: 'warning', title: '参数被上游拒绝，已自动回退', message: 'quality 已去掉' });
  dialog.show({ tone: 'danger', title: '连不上服务器', message: '浏览器连不上生图接口', retry: retryFor('tag-c') });
  assert.equal(items().length, 3);
  assert.deepEqual(
    retryButtons().map(button => button.textContent),
    ['↻ 全部重新生成', '↻ 重新生成'],
    '回退提醒不带按钮',
  );

  retryButtons()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(dialog.root.hidden, false, '焦点在按钮上按 Enter 是按按钮，不是关弹窗');
  assert.deepEqual(runs, []);

  retryButtons()[0].click();
  assert.deepEqual(runs, ['tag-a', 'tag-b'], '合并的两张一起重跑，同一张只跑一次');
  assert.equal(dialog.root.hidden, false, '别的报错还在，弹窗不关');
  assert.equal(items().length, 2);
  assert.equal(dialog.root.textContent.includes('请求超时'), false);
  assert.equal(document.activeElement, panel);

  retryButtons()[0].click();
  assert.deepEqual(runs, ['tag-a', 'tag-b', 'tag-c']);
  assert.equal(items().length, 1, '只剩回退提醒');
  dialog.root.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.root.hidden, true);
  assert.equal(runs.length, 3, '点别处只是关，不重跑');

  dialog.show({ ...timeout, retry: retryFor('tag-d') });
  retryButtons()[0].click();
  assert.equal(dialog.root.hidden, true, '最后一条点了重新生成，整个弹窗关掉');
  assert.equal(runs.at(-1), 'tag-d');
});

test('画廊报错交给报错弹窗，并带上原始错误', async t => {
  withDom(t);
  const reported = [];
  const failure = Object.assign(new Error('服务端插件不可用'), { code: 'SERVER_PLUGIN_UNAVAILABLE' });
  const page = createGalleryPage({
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => { throw failure; },
    fileUrl: id => `/images/${id}.png`,
  }, { onError: (error, title) => reported.push({ error, title }) });
  document.body.append(page.root);
  await page.load();
  assert.equal(reported.length, 1);
  assert.equal(reported[0].title, '画廊操作失败');
  assert.equal(reported[0].error.message, '服务端插件不可用');
  assert.equal(describeError(reported[0].error, reported[0].title).title, '连不上服务器', '错误类别保留');
});

test('报错弹窗开关只存在浏览器本地，增强模式也不发给服务端', async t => {
  const extensionSettings = { stImageAtelier: { settings: { executionMode: 'server' } } };
  const remote = { enabled: true, autoGenerate: false, enableSmartRetry: false };
  const patches = [];
  mockFetch(t, (body, _call, url, options) => {
    if (!/\/api\/plugins\/st-image-atelier\/settings$/.test(String(url))) {
      return new Response('', { status: 404 });
    }
    if (options?.method === 'PATCH') {
      patches.push(body);
      Object.assign(remote, body);
    }
    return json(200, { ok: true, data: { ...remote } });
  });
  const api = createApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  assert.equal((await api.getSettings()).enableErrorPopup, true, '默认开启');
  const updated = await api.updateSettings({ enableErrorPopup: false });
  assert.equal(updated.enableErrorPopup, false);
  assert.equal(patches.some(patch => 'enableErrorPopup' in patch), false, '不发给服务端插件');
  assert.equal((await api.getSettings()).enableErrorPopup, false);
  assert.equal(extensionSettings.stImageAtelier.settings.enableErrorPopup, false);

  await api.updateSettings({ enableErrorPopup: true, enableSmartRetry: true });
  assert.deepEqual(patches.at(-1), { enableSmartRetry: true }, '其他设置照常同步');
});
