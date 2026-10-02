'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

/* 给生图请求用的最小 fetch：Node 自带的 fetch（undici）300 秒拿不到响应头就报
   UND_ERR_HEADERS_TIMEOUT，中转站排队十几二十分钟的图等不完。这里不设响应头和正文超时，
   多久算超时只由调用方的 AbortSignal（预设里的「超时」）决定；开 TCP keepalive，免得长时间
   没有数据的连接被路由器悄悄断掉。不跟随跳转，与 redirect: 'error' 一致：3xx 原样返回。 */
function decode(response) {
  const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return response.pipe(zlib.createInflate());
  if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());
  return response;
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function longFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method,
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
    }, response => {
      const chunks = [];
      const stream = decode(response);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', fail);
      stream.on('end', () => {
        cleanup();
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          statusText: response.statusMessage || '',
          headers: { get: name => response.headers[String(name).toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    const onAbort = () => request.destroy(abortError(signal));
    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }
    function fail(error) {
      cleanup();
      reject(error);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('socket', socket => socket.setKeepAlive(true, 30_000));
    request.on('error', fail);
    if (body != null) request.write(body);
    request.end();
  });
}

module.exports = { longFetch };
