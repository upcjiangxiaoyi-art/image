import { DirectError, bytesToBase64 } from './openai-direct.js';

/* 酒馆的用户文件（user/files）读、写、删。
   - 读：GET /user/files/<名字>（酒馆用 res.sendFile，带 ETag）。带了本机缓存时发 If-None-Match，
     没变就回 304、一个字节的正文都不传，直接用缓存里的那份。ETag 是自己带上去的，不靠浏览器的 HTTP 缓存
     （cache: 'no-store' 加 ?t= 照旧），读到的一定是服务器当前的文件。
     条件请求还得自己带一个 Cache-Control: max-age=0：不带的话浏览器会给 no-store 的请求补上
     Cache-Control: no-cache，而 express 见了 no-cache 就当成「强制刷新」，ETag 对得上也照样回整份正文。
   - 写：POST /api/files/upload（酒馆是原子写）。文件名只能是字母数字、下划线、横线、点。
   - 删：POST /api/files/delete，老版本酒馆没有这个接口，删不掉就算了。 */
const SPACE = 0x20;

export function createTavernFiles(compat, fetchImpl = globalThis.fetch, { cache = null, label = '文件' } = {}) {
  function request(name, method, headers) {
    return fetchImpl(`/user/files/${name}?t=${Date.now()}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(headers ? { headers } : {}),
    });
  }

  return {
    /* 返回 { status: 200, text, etag } 或 { status: 404 }；别的状态抛错（宁可读失败，也不把读不到当成空的）。
       cached：先看本机缓存，带着它的 ETag 去问。读到新的不在这里存——等调用方确认内容能用了再 remember()。 */
    async read(name, { cached = false } = {}) {
      const hit = cached && cache ? await cache.get(name) : null;
      let response = await request(name, 'GET', hit?.etag
        ? { 'If-None-Match': hit.etag, 'Cache-Control': 'max-age=0' }
        : null);
      if (response.status === 304) {
        if (hit) return { status: 200, text: hit.text, etag: hit.etag, cached: true };
        response = await request(name, 'GET', null);
      }
      if (response.status === 404) {
        if (cached && cache) cache.delete(name);
        return { status: 404 };
      }
      if (!response.ok) {
        throw new DirectError('LOCAL_SAVE_FAILED', `读取${label}失败（HTTP ${response.status}）`, response.status);
      }
      return { status: 200, text: await response.text(), etag: response.headers?.get?.('etag') || '' };
    },

    /* 这份正文确认能用（解析得出来），记进本机缓存，下次没变就不用再下载。 */
    remember(name, { etag, text } = {}) {
      if (cache && etag && typeof text === 'string') cache.set(name, { etag, text });
    },

    /* 本机缓存里这个前缀下、不在 keep 里的都清掉（分片已经不在清单上了）。 */
    forget(prefix, keep) {
      if (cache?.prune) cache.prune(prefix, keep);
    },

    /* 只看文件头：{ status, etag }；问不到返回 null，不抛错。 */
    async head(name) {
      try {
        const response = await request(name, 'HEAD', null);
        return { status: response.status, etag: response.headers?.get?.('etag') || '' };
      } catch {
        return null;
      }
    },

    /* 这些文件在不在：返回 { 名字: true/false }。一次请求问完（酒馆的 /api/files/verify）；
       老版本酒馆没有这个接口、网络断了就返回 null，不抛错。 */
    async exists(names) {
      try {
        const response = await fetchImpl('/api/files/verify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: compat.headers(),
          body: JSON.stringify({ urls: names.map(name => `user/files/${name}`) }),
        });
        if (!response.ok) return null;
        const payload = await response.json();
        return Object.fromEntries(names.map(name => [name, payload?.[`user/files/${name}`] === true]));
      } catch {
        return null;
      }
    },

    /* 写一个文件，返回写上去的字节数。
       avoidSize：酒馆的 ETag 是「大小 + 修改时间」，有的文件系统修改时间只精确到秒；连着两次写大小又一样，
       ETag 就分不出来。所以新的一份和上一份一样大时在末尾多垫一个空格（JSON 允许）。 */
    async write(name, text, { avoidSize = null } = {}) {
      let bytes = new TextEncoder().encode(text);
      if (avoidSize !== null && bytes.length === avoidSize) {
        const padded = new Uint8Array(bytes.length + 1);
        padded.set(bytes);
        padded[bytes.length] = SPACE;
        bytes = padded;
      }
      const response = await fetchImpl('/api/files/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: compat.headers(),
        body: JSON.stringify({ name, data: bytesToBase64(bytes) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new DirectError(
          'LOCAL_SAVE_FAILED',
          payload?.error || `写入${label}失败（HTTP ${response.status}）`,
          response.status,
        );
      }
      return bytes.length;
    },

    /* 删一个文件：删掉了返回 true；接口不在、文件不在、网络断了都返回 false，不抛错。 */
    async remove(name) {
      if (cache) cache.delete(name);
      try {
        const response = await fetchImpl('/api/files/delete', {
          method: 'POST',
          credentials: 'same-origin',
          headers: compat.headers(),
          body: JSON.stringify({ path: `user/files/${name}` }),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
