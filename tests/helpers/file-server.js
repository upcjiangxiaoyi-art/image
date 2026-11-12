/* 只有「用户文件」那几条接口的假酒馆：GET/HEAD /user/files/<名字>（带 ETag、认 If-None-Match）、
   POST /api/files/upload、POST /api/files/delete。分片存储的单元测试用它，所有请求都记了账。
   coarseEtag：模拟修改时间只精确到秒的文件系统——ETag 只跟大小有关，内容变了大小没变就看不出来。
   opaqueEtag：模拟中间有代理把 ETag 换成了自己的格式（nginx 那种「修改时间-大小」）——样子像，
   但第一段不是文件大小。 */
const NAME_RULE = /^[a-zA-Z0-9_\-.]+$/;

function contentHash(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
  return hash.toString(16);
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

export function createFileServer({ coarseEtag = false, opaqueEtag = false } = {}) {
  const server = {
    files: new Map(),
    /* { name, bytes, bodyBytes, text } */
    uploads: [],
    /* { name, method, status, bytes } */
    reads: [],
    deletes: [],
    /* (name) => true 就让这次上传失败（HTTP 500）。 */
    failUpload: null,
    /* (name) => true 就让这次读取失败（HTTP 500）；返回一个数字就用它当状态码。 */
    failRead: null,
    /* (name) => promise：上传要等它才落到服务器上。 */
    uploadGate: null,
    /* (name, method) => promise：读取的回音要等它才到。内容是请求到服务器那一刻的（路上慢，不是服务器慢）。 */
    readGate: null,
    /* 页面没了：之后发的、还在路上的请求都不再有回音。 */
    dead: false,
    deleteSupported: true,
    verifySupported: true,
    /* 每次 /api/files/verify 问了哪些文件。 */
    verifies: [],
  };

  const etagOf = text => (opaqueEtag
    ? `"${(0x6912_0000 + (Number.parseInt(contentHash(text), 16) % 0xffff)).toString(16)}-${Buffer.byteLength(text).toString(16)}"`
    : `W/"${Buffer.byteLength(text).toString(16)}-${coarseEtag ? '0' : contentHash(text)}"`);
  const hang = () => new Promise(() => {});

  server.fetch = async (url, options = {}) => {
    if (server.dead) return hang();
    const target = String(url);
    const method = options.method || 'GET';
    if (target === '/api/files/upload') {
      const body = JSON.parse(options.body);
      const content = Buffer.from(body.data, 'base64');
      const entry = { name: body.name, bytes: content.length, bodyBytes: Buffer.byteLength(options.body), text: content.toString('utf8') };
      server.issued.push(entry.name);
      if (server.uploadGate) await server.uploadGate(body.name);
      if (server.dead) return hang();
      if (!NAME_RULE.test(body.name)) return new Response('Illegal character in filename', { status: 400 });
      if (server.failUpload?.(body.name)) return new Response('', { status: 500 });
      server.files.set(body.name, entry.text);
      server.uploads.push(entry);
      return new Response(JSON.stringify({ path: `user/files/${body.name}` }), { status: 200 });
    }
    if (target === '/api/files/verify') {
      if (!server.verifySupported) return new Response('Not Found', { status: 404 });
      const urls = JSON.parse(options.body).urls;
      server.verifies.push(urls);
      return new Response(JSON.stringify(Object.fromEntries(urls.map(item => [item, server.files.has(item.replace(/^user\/files\//, ''))]))), { status: 200 });
    }
    if (target === '/api/files/delete') {
      if (!server.deleteSupported) return new Response('Not Found', { status: 404 });
      const name = String(JSON.parse(options.body).path || '').replace(/^user\/files\//, '');
      if (!server.files.has(name)) return new Response('File not found', { status: 404 });
      server.files.delete(name);
      server.deletes.push(name);
      return new Response('OK', { status: 200 });
    }
    if (target.startsWith('/user/files/')) {
      const name = decodeURIComponent(target.slice('/user/files/'.length).split('?')[0]);
      const log = (status, bytes = 0) => server.reads.push({ name, method, status, bytes });
      const failed = server.failRead?.(name);
      const found = server.files.has(name);
      const text = found ? server.files.get(name) : '';
      if (server.readGate) await server.readGate(name, method);
      if (server.dead) return hang();
      if (failed) {
        const status = typeof failed === 'number' ? failed : 500;
        log(status);
        return new Response('', { status });
      }
      if (!found) {
        log(404);
        return new Response('Not Found', { status: 404 });
      }
      const etag = etagOf(text);
      if (method === 'HEAD') {
        log(200);
        return new Response(null, { status: 200, headers: { ETag: etag } });
      }
      /* express（fresh 模块）见到请求里有 Cache-Control: no-cache 就不比 ETag、直接回整份。浏览器会给
         cache: 'no-store' 的请求自动补上这个头，除非请求自己带了 Cache-Control——所以没带的一律当成有 no-cache。 */
      const cacheControl = headerOf(options.headers, 'Cache-Control');
      const forcedReload = cacheControl === null || /(?:^|,)\s*no-cache\s*(?:,|$)/.test(cacheControl);
      if (!forcedReload && headerOf(options.headers, 'If-None-Match') === etag) {
        log(304);
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      log(200, Buffer.byteLength(text));
      return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag } });
    }
    throw new Error(`意外的请求：${method} ${target}`);
  };

  /* 已经发出去的上传（不管到没到服务器）。 */
  server.issued = [];
  server.json = name => JSON.parse(server.files.get(name));
  server.put = (name, value) => server.files.set(name, typeof value === 'string' ? value : JSON.stringify(value));
  server.names = prefix => [...server.files.keys()].filter(name => name.startsWith(prefix)).sort();
  server.resetLogs = () => {
    server.uploads.length = 0;
    server.reads.length = 0;
    server.deletes.length = 0;
    server.issued.length = 0;
    server.verifies.length = 0;
  };
  return server;
}

export const compat = { headers: () => ({ 'Content-Type': 'application/json' }) };
