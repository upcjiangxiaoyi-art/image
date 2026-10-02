/* 直连（浏览器）和可选的 Server Plugin（Node）共用的 OpenAI Images 兼容请求逻辑：地址拼接、
   请求体、报错归类与提示、智能重试、响应解析。两边只各自提供报错类和「网络不通」时的说法。
   Server Plugin 是 CommonJS，用动态 import() 加载这份文件，安装脚本会把它拷进插件目录，
   所以这里不能 import 任何别的文件，只用 fetch / URL / AbortController 这些两边都有的东西。 */

/* 审核拦截的说法五花八门：OpenAI 是 safety system / moderation_blocked，中转站常见 unsafe、
   NSFW、违规、敏感词。命中时给审核提示，也绝不智能重试。 */
export const MODERATION_PATTERN = /moderation|moderated|content (?:was )?rejected|safety|unsafe|nsfw|content policy|policy violation|内容审核|审核不通过|审核未通过|内容政策|安全策略|内容违规|违规内容|涉嫌违规|违规词|敏感词|敏感内容|不安全内容|内容不安全/i;
export const MODERATION_HINT = '；提示词被上游内容审核拒绝，请减少强迫、暴力、露骨或高风险内容后重试';
export const RESPONSE_FORMATS = Object.freeze(['b64_json', 'url', '']);

const SMART_RETRY_PARAMETERS = Object.freeze([
  ['response_format', /response[_ -]?format/i],
  ['size', /\bsize\b|尺寸/i],
  ['quality', /\bquality\b|质量/i],
  ['n', /(?:parameter|param|field|参数)\s*['"`]?n(?:['"`]|\b)|\bn_samples\b|number of images|张数/i],
]);
const PARAMETER_INCOMPATIBLE = /unsupported|not support|unknown (?:parameter|field)|unrecognized|invalid|unexpected|not allowed|must be|expected|不支持|未知参数|无效|非法|不兼容|不允许/i;
const NEVER_RETRY_REASON = /余额|quota|配额/i;

export function normalizeImageSize(value) {
  return String(value || '')
    .trim()
    .replace(/(\d)\s*[×✕✖＊*X]\s*(\d)/g, '$1x$2');
}

export function normalizeResponseFormat(value) {
  if (value === undefined || value === null) return 'b64_json';
  const text = String(value).trim();
  return RESPONSE_FORMATS.includes(text) ? text : 'b64_json';
}

export function sanitizeUpstreamText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9._-]{6,}\b/g, '[已隐藏密钥]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function extractUpstreamError(bodyText) {
  let value = bodyText;
  try {
    const payload = JSON.parse(bodyText);
    value = payload?.error?.message
      || payload?.error?.detail
      || payload?.message
      || payload?.detail
      || (typeof payload?.error === 'string' ? payload.error : '')
      || bodyText;
  } catch {
    // Plain-text error bodies are common among OpenAI-compatible gateways.
  }
  return sanitizeUpstreamText(value) || '上游没有返回错误详情';
}

function findDataArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) return payload.data;
  for (const key of ['result', 'output', 'response']) {
    const found = findDataArray(payload[key]);
    if (found) return found;
  }
  return null;
}

/* 有些中转站拦截时照样回 HTTP 200，只在正文里写 error / message，没有图片。 */
function payloadErrorOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const { error } = payload;
  const value = (typeof error === 'string' ? error : error?.message || error?.detail)
    || payload.message
    || payload.detail
    || payload.msg;
  return typeof value === 'string' ? sanitizeUpstreamText(value) : '';
}

function authorization(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

/* ErrorClass 的构造参数统一为 (code, details, status, retryable, publicMessage)。
   httpStatus 决定报错里的 status：浏览器直接用上游状态码；Server Plugin 把上游 HTTP
   错误报成 502，状态码另存在 upstreamStatus。networkError 给出「请求根本没发出去」的说法。 */
/* fetchImpl：默认用当前环境的 fetch（调用时再取，测试可以替换）。Server Plugin 换成自己的
   HTTP 客户端，因为 Node 自带的 fetch 300 秒拿不到响应头就放弃，排队慢的图等不完。 */
export function createOpenAiImagesCore({
  ErrorClass,
  networkError,
  httpStatus = (_code, status) => status,
  fetchImpl = (url, options) => fetch(url, options),
}) {
  const fail = (code, details = '', status = 400, retryable = false, publicMessage = '') =>
    new ErrorClass(code, details, status, retryable, publicMessage);

  function normalizeEndpoint(baseUrl, endpointPath) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw fail('VALIDATION_FAILED', 'Base URL 无效');
    }
    const baseParts = url.pathname.split('/').filter(Boolean);
    const endpointParts = String(endpointPath || '').split('/').filter(Boolean);
    if (baseParts.at(-1)?.toLowerCase() === 'v1' && endpointParts[0]?.toLowerCase() === 'v1') {
      endpointParts.shift();
    }
    url.pathname = `/${[...baseParts, ...endpointParts].join('/')}`;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }

  function validateEndpoint(urlString, allowHttp = false) {
    const url = new URL(urlString);
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      throw fail('VALIDATION_FAILED', '默认只允许 HTTPS；本地服务需明确开启 HTTP');
    }
    if (url.username || url.password) {
      throw fail('VALIDATION_FAILED', 'URL 不得包含用户名或密码');
    }
    return url;
  }

  function parseImageResponse(payload) {
    const items = findDataArray(payload);
    if (!items?.length) {
      const reason = payloadErrorOf(payload);
      if (reason) {
        throw fail(
          'UPSTREAM_RESPONSE_INVALID',
          reason,
          502,
          false,
          `上游没有返回图片：${reason}${MODERATION_PATTERN.test(reason) ? MODERATION_HINT : ''}`,
        );
      }
      throw fail('UPSTREAM_RESPONSE_INVALID', '响应中没有图片数组');
    }
    const results = items.map((item, generationIndex) => {
      if (!item || typeof item !== 'object') return null;
      if (typeof item.b64_json === 'string' && item.b64_json) {
        return { sourceType: 'base64', value: item.b64_json, generationIndex };
      }
      if (typeof item.url === 'string' && item.url) {
        return { sourceType: 'url', value: item.url, generationIndex };
      }
      return null;
    }).filter(Boolean);
    if (!results.length) throw fail('UPSTREAM_RESPONSE_INVALID', '响应中没有 url 或 b64_json');
    return results;
  }

  function parseModelsResponse(payload) {
    const items = Array.isArray(payload) ? payload : payload?.data;
    if (!Array.isArray(items)) throw fail('UPSTREAM_RESPONSE_INVALID', '模型列表格式不兼容');
    return items
      .map(item => typeof item === 'string'
        ? { id: item }
        : { id: String(item?.id ?? ''), ...(item?.owned_by ? { ownedBy: item.owned_by } : {}) })
      .filter(item => item.id);
  }

  function mapStatus(status, bodyText) {
    const reason = extractUpstreamError(bodyText);
    let error;
    if (status === 401 || status === 403) {
      error = fail(
        'UPSTREAM_AUTH_FAILED',
        reason,
        httpStatus('UPSTREAM_AUTH_FAILED', status),
        false,
        `API 鉴权失败（HTTP ${status}）：${reason}`,
      );
    } else if (status === 429) {
      error = fail(
        'UPSTREAM_RATE_LIMITED',
        reason,
        httpStatus('UPSTREAM_RATE_LIMITED', status),
        true,
        `API 限流（HTTP 429）：${reason}`,
      );
    } else {
      const hint = status === 404
        ? '；请检查“生图路径”是否与该 API 一致'
        : MODERATION_PATTERN.test(reason)
          ? MODERATION_HINT
          : status === 400
            ? '；若上游提示参数不支持，可把「默认尺寸 / 默认质量 / 默认数量」改成「不发送」'
            : '';
      error = fail(
        'UPSTREAM_HTTP_ERROR',
        reason,
        httpStatus('UPSTREAM_HTTP_ERROR', status),
        status >= 500,
        `上游生图请求失败（HTTP ${status}）：${reason}${hint}`,
      );
    }
    error.upstreamStatus = status;
    return error;
  }

  async function fetchJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const externalSignal = options.signal;
    const abort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
      const text = await response.text();
      if (!response.ok) throw mapStatus(response.status, text.slice(0, 1000));
      try {
        return JSON.parse(text);
      } catch {
        throw fail('UPSTREAM_RESPONSE_INVALID', '上游返回的不是 JSON');
      }
    } catch (error) {
      if (error instanceof ErrorClass) throw error;
      if (controller.signal.aborted) {
        throw fail('UPSTREAM_TIMEOUT', '请求已超时或取消', 504, true);
      }
      throw networkError(error);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  function detectCompatibilityRetry(error, body = {}) {
    if (!(error instanceof ErrorClass)
      || error.code !== 'UPSTREAM_HTTP_ERROR'
      || ![400, 422].includes(error.upstreamStatus ?? error.status)) return null;
    const details = String(error.details || '');
    if (!PARAMETER_INCOMPATIBLE.test(details)
      || MODERATION_PATTERN.test(details)
      || NEVER_RETRY_REASON.test(details)) return null;
    const adjustedParameters = SMART_RETRY_PARAMETERS
      .filter(([name, pattern]) => Object.hasOwn(body, name) && pattern.test(details))
      .map(([name]) => name);
    if (!adjustedParameters.length) return null;
    return {
      attempted: true,
      adjustedParameters,
      reason: `${adjustedParameters.join('、')} 参数不兼容`,
      message: `检测到 ${adjustedParameters.join('、')} 参数不兼容，正在回退并重试（1/1）`,
    };
  }

  function rejectsResponseFormat(error) {
    return Boolean(detectCompatibilityRetry(error, { response_format: 'b64_json' })
      ?.adjustedParameters.includes('response_format'));
  }

  /* 标签 quality → 默认质量（选「不发送」则不发）→「额外请求参数 JSON」最后覆盖。
     默认请求 b64_json 内嵌返回：很多中转站会把图片转成图床 URL，浏览器再去拉那张图时
     常被 CORS 或跳转拦下（尤其手机）。内嵌返回跳过这一步。「额外请求参数 JSON」可覆盖。 */
  function buildRequestBody({ preset, prompt, parameters = {} }) {
    const body = { model: preset.selectedModel, prompt };
    if (preset.sendSize) body.size = normalizeImageSize(parameters.size || preset.defaultSize);
    if (preset.sendQuality) body.quality = parameters.quality || preset.defaultQuality;
    if (preset.sendN) body.n = parameters.count || preset.defaultCount;
    const responseFormat = normalizeResponseFormat(preset.responseFormat);
    if (responseFormat) body.response_format = responseFormat;
    Object.assign(body, preset.extraBody || {}, parameters.extraBody || {});
    body.model = preset.selectedModel;
    body.prompt = prompt;
    if ('size' in body) body.size = normalizeImageSize(body.size);
    return body;
  }

  async function generateImages({
    preset,
    apiKey,
    prompt,
    parameters = {},
    settings = {},
    signal,
    onCompatibilityRetry,
  }) {
    if (!preset.baseUrl) throw fail('PRESET_NOT_CONFIGURED');
    if (!apiKey) throw fail('API_KEY_MISSING');
    if (!preset.selectedModel) throw fail('MODEL_NOT_SELECTED');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) {
      throw fail('VALIDATION_FAILED', '提示词必须为 1-20000 个字符');
    }
    const endpoint = normalizeEndpoint(preset.baseUrl, preset.generationPath);
    validateEndpoint(endpoint, settings.allowHttp);
    const body = buildRequestBody({ preset, prompt: prompt.trim(), parameters });
    const request = payloadBody => fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authorization(apiKey) },
      body: JSON.stringify(payloadBody),
      signal,
    }, preset.timeoutMs);
    let payload;
    try {
      payload = await request(body);
    } catch (error) {
      const retry = settings.enableSmartRetry ? detectCompatibilityRetry(error, body) : null;
      if (!retry || signal?.aborted) throw error;
      const fallbackBody = { ...body };
      for (const parameter of retry.adjustedParameters) delete fallbackBody[parameter];
      console.info('[画笺] 智能兼容重试', retry.reason);
      await onCompatibilityRetry?.(retry);
      if (signal?.aborted) throw signal.reason || fail('UPSTREAM_TIMEOUT', '请求已取消', 504, true);
      try {
        payload = await request(fallbackBody);
      } catch (retryError) {
        retryError.compatibilityRetry = retry;
        throw retryError;
      }
    }
    return parseImageResponse(payload);
  }

  async function listModels({ preset, apiKey, settings = {}, signal }) {
    if (!preset.baseUrl) throw fail('PRESET_NOT_CONFIGURED');
    if (!apiKey) throw fail('API_KEY_MISSING');
    const endpoint = normalizeEndpoint(preset.baseUrl, preset.modelsPath);
    validateEndpoint(endpoint, settings.allowHttp);
    const payload = await fetchJson(endpoint, {
      method: 'GET',
      headers: authorization(apiKey),
      signal,
    }, Math.min(preset.timeoutMs, 60_000));
    return parseModelsResponse(payload);
  }

  return {
    normalizeEndpoint,
    validateEndpoint,
    parseImageResponse,
    parseModelsResponse,
    mapStatus,
    fetchJson,
    detectCompatibilityRetry,
    rejectsResponseFormat,
    buildRequestBody,
    generateImages,
    listModels,
  };
}
