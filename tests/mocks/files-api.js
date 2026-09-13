/* 酒馆用户文件接口的内存模拟：POST /api/files/upload 写、GET /user/files/<name> 读。
   画廊索引就靠这两个接口落盘，测试里用它替代真实服务端。 */
export function createFilesApiMock() {
  const files = new Map();
  let uploads = 0;

  function decodeBase64(value) {
    return new TextDecoder().decode(Uint8Array.from(Buffer.from(String(value), 'base64')));
  }

  async function handle(url, options = {}) {
    if (url === '/api/files/upload') {
      const body = JSON.parse(options.body);
      files.set(String(body.name), decodeBase64(body.data));
      uploads += 1;
      return new Response(JSON.stringify({ path: `user/files/${body.name}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (typeof url === 'string' && url.startsWith('/user/files/')) {
      const name = url.slice('/user/files/'.length).split('?')[0];
      if (!files.has(name)) return new Response('Not Found', { status: 404 });
      return new Response(files.get(name), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return null;
  }

  return {
    files,
    handle,
    uploadCount: () => uploads,
    read(name) {
      return files.has(name) ? JSON.parse(files.get(name)) : null;
    },
    write(name, value) {
      files.set(name, JSON.stringify(value));
    },
  };
}
