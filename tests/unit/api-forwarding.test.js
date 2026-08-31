/* 转发回归 —— 加在 direct-client 上的方法，上层 client 必须显式转发，
   否则面板拿到的 api 上根本没有这个方法。（Claude Opus 5） */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const client = fs.readFileSync(new URL('../../src/ui/api/client.js', import.meta.url), 'utf8');
const direct = fs.readFileSync(new URL('../../src/ui/api/direct-client.js', import.meta.url), 'utf8');

test('画廊清理相关方法必须在上层 client 里转发出去', () => {
  for (const name of ['cleanupGallery', 'pruneGallery']) {
    assert.ok(direct.includes(`${name},`) || direct.includes(`${name}:`),
      `direct-client 应导出 ${name}`);
    assert.ok(new RegExp(`\\b${name}\\s*:`).test(client),
      `上层 client 漏了转发 ${name} —— 面板会报 api.${name} is not a function`);
  }
});
