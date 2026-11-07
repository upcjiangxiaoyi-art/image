/* 1.9.0 画廊缩略图：尺寸算法和生成流程（解码 / 编码可注入，Node 里没有 canvas）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THUMBNAIL_FOLDER,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_QUALITY,
  createThumbnail,
  fitWithin,
} from '../../src/ui/media/thumbnail.js';

test('长边缩到 768 以内、等比；本来就小的不放大；坏尺寸兜成 1', () => {
  assert.equal(THUMBNAIL_MAX_EDGE, 768);
  assert.deepEqual(fitWithin(2048, 2048), { width: 768, height: 768, scaled: true });
  assert.deepEqual(fitWithin(1024, 1792), { width: 439, height: 768, scaled: true });
  assert.deepEqual(fitWithin(4096, 2048), { width: 768, height: 384, scaled: true });
  assert.deepEqual(fitWithin(512, 300), { width: 512, height: 300, scaled: false });
  assert.deepEqual(fitWithin(768, 768), { width: 768, height: 768, scaled: false });
  assert.deepEqual(fitWithin(0, NaN), { width: 1, height: 1, scaled: false });
  assert.deepEqual(fitWithin(3000, 1000, 300), { width: 300, height: 100, scaled: true });
});

test('createThumbnail：解码、按算好的尺寸编码成 JPEG、用完关掉位图', async () => {
  const calls = [];
  let closed = 0;
  const bitmap = { width: 2048, height: 3584, close: () => { closed += 1; } };
  const result = await createThumbnail(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
    decode: async blob => { calls.push(['decode', blob.size, blob.type]); return bitmap; },
    encode: async (source, options) => {
      calls.push(['encode', source === bitmap, options.width, options.height, options.type, options.quality, options.background]);
      return new Blob([new Uint8Array(10)], { type: options.type });
    },
  });
  assert.equal(result.width, 439);
  assert.equal(result.height, 768);
  assert.equal(result.type, 'image/jpeg');
  assert.equal(result.blob.size, 10);
  assert.deepEqual(calls, [
    ['decode', 3, 'image/png'],
    ['encode', true, 439, 768, 'image/jpeg', THUMBNAIL_QUALITY, '#1a1b1e'],
  ]);
  assert.equal(closed, 1, '位图用完关掉');
  assert.equal(THUMBNAIL_FOLDER, 'st-image-atelier-thumbs');
});

test('解不了、编不了都返回 null（画廊退回用原图），位图照样关掉', async () => {
  let closed = 0;
  const bitmap = { width: 10, height: 10, close: () => { closed += 1; } };
  assert.equal(await createThumbnail(new Blob([]), { decode: async () => null }), null);
  assert.equal(await createThumbnail(new Blob([]), { decode: async () => bitmap, encode: async () => null }), null);
  assert.equal(closed, 1);
});

test('默认解码在没有 createImageBitmap 的环境里返回 null，不报错', async () => {
  const previous = globalThis.createImageBitmap;
  delete globalThis.createImageBitmap;
  try {
    assert.equal(await createThumbnail(new Blob([new Uint8Array([1])])), null);
  } finally {
    if (previous) globalThis.createImageBitmap = previous;
  }
});
