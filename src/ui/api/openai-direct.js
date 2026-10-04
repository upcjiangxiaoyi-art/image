import {
  createOpenAiImagesCore,
  extractUpstreamError,
  MODERATION_PATTERN,
  normalizeImageSize,
  normalizeResponseFormat,
  RESPONSE_FORMATS,
} from '../../shared/openai-images-core.js';

const ERROR_MESSAGES = {
  PRESET_NOT_CONFIGURED: 'API 预设未配置',
  API_KEY_MISSING: '缺少 API 密钥',
  MODEL_NOT_SELECTED: '未选择模型',
  UPSTREAM_AUTH_FAILED: 'API 鉴权失败，请检查密钥',
  UPSTREAM_RATE_LIMITED: 'API 限流，请稍后重试',
  UPSTREAM_TIMEOUT: '请求超时',
  UPSTREAM_HTTP_ERROR: '上游服务错误',
  UPSTREAM_RESPONSE_INVALID: '返回格式不兼容',
  DIRECT_FETCH_BLOCKED: '浏览器连不上生图接口（网络层失败，没有收到任何响应），请检查地址、网络和中转站的 CORS 设置',
  IMAGE_DOWNLOAD_FAILED: '图片下载失败',
  LOCAL_SAVE_FAILED: '图片保存到酒馆失败',
  VALIDATION_FAILED: '请求参数无效',
  TAG_NOT_FOUND: '这张卡片对应的消息已经重新生成或改动过，生图标签已失效',
};

export class DirectError extends Error {
  constructor(code, details = '', status = 400, retryable = false, publicMessage = '') {
    super(publicMessage || ERROR_MESSAGES[code] || '生图请求失败');
    this.name = 'DirectError';
    this.code = code;
    this.details = details;
    this.status = status;
    this.retryable = retryable;
  }
}

/* 请求逻辑与 Server Plugin 共用 src/shared/openai-images-core.js，这里只提供浏览器端的
   报错类和「连不上」的说法；下面的图片字节处理是浏览器专用的。 */
const core = createOpenAiImagesCore({
  ErrorClass: DirectError,
  networkError: error => new DirectError('DIRECT_FETCH_BLOCKED', error?.message || 'Failed to fetch', 0, true),
});

export const {
  normalizeEndpoint,
  validateEndpoint,
  parseImageResponse,
  parseModelsResponse,
  fetchJson,
  detectCompatibilityRetry,
  rejectsResponseFormat,
  buildRequestBody,
  generateImages,
} = core;
export const listModelsDirect = core.listModels;
export {
  extractUpstreamError,
  MODERATION_PATTERN,
  normalizeImageSize,
  normalizeResponseFormat,
  RESPONSE_FORMATS,
};

export function detectImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const begins = values => values.every((value, index) => bytes[index] === value);
  if (begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (begins([0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const clean = String(value).replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
