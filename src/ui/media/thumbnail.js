/* 画廊缩略图：出图存好原图之后，顺手做一张长边不超过 THUMBNAIL_MAX_EDGE 的 JPEG，画廊格子用它；
   看图器、下载、参考重画、聊天里的卡片都用原图。原图一个字节不动，生成请求也不动。
   为什么：手机上画廊一屏解码几十张原图（2K 一张解码后 17 MB）是发烫的大头，缩略图之后一屏不到 1 MB。 */
export const THUMBNAIL_MAX_EDGE = 768;
export const THUMBNAIL_QUALITY = 0.82;
export const THUMBNAIL_FOLDER = 'st-image-atelier-thumbs';

/* 长边缩到 maxEdge 以内、等比；本来就小的不放大。 */
export function fitWithin(width, height, maxEdge = THUMBNAIL_MAX_EDGE) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 0));
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= maxEdge) return { width: sourceWidth, height: sourceHeight, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(sourceWidth * ratio)),
    height: Math.max(1, Math.round(sourceHeight * ratio)),
    scaled: true,
  };
}

/* 浏览器默认实现：createImageBitmap 解码、canvas 缩放、JPEG 编码。
   没有这些 API（老浏览器、测试环境）就返回 null，画廊退回用原图。 */
async function defaultDecode(blob) {
  if (typeof createImageBitmap !== 'function') return null;
  return createImageBitmap(blob);
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = globalThis.document?.createElement?.('canvas');
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function defaultEncode(bitmap, { width, height, type, quality, background }) {
  const canvas = makeCanvas(width, height);
  const context = canvas?.getContext?.('2d');
  if (!context) return null;
  /* JPEG 没有透明通道：透明底先垫一层，免得变成一团黑。 */
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/* 返回 { blob, width, height, type }；做不了返回 null。decode / encode 可注入（测试用）。 */
export async function createThumbnail(blob, {
  maxEdge = THUMBNAIL_MAX_EDGE,
  quality = THUMBNAIL_QUALITY,
  type = 'image/jpeg',
  background = '#1a1b1e',
  decode = defaultDecode,
  encode = defaultEncode,
} = {}) {
  const bitmap = await decode(blob);
  if (!bitmap) return null;
  try {
    const size = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const encoded = await encode(bitmap, { ...size, type, quality, background });
    return encoded ? { blob: encoded, width: size.width, height: size.height, type } : null;
  } finally {
    bitmap.close?.();
  }
}
