#!/usr/bin/env node
/* 检查酒馆 settings.json 里 Image Atelier 命名空间的体积构成。
   用法：node scripts/inspect-settings.mjs /path/to/data/<user>/settings.json [gallery.json]
   期望（1.6.2 起）：命名空间里没有 gallery / deletedResultIds，只有设置项；
   画廊记录在 user/files/st-image-atelier-gallery.json 里。 */
import fs from 'node:fs';

const [settingsPath, galleryPath] = process.argv.slice(2);
if (!settingsPath) {
  console.error('用法：node scripts/inspect-settings.mjs <settings.json> [st-image-atelier-gallery.json]');
  process.exit(2);
}

const raw = fs.readFileSync(settingsPath, 'utf8');
const settings = JSON.parse(raw);
const namespace = settings?.extension_settings?.stImageAtelier ?? settings?.stImageAtelier ?? null;
const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

console.log(`settings.json：${(Buffer.byteLength(raw, 'utf8') / 1024 / 1024).toFixed(2)} MB`);
if (!namespace) {
  console.log('没有 stImageAtelier 命名空间');
  process.exit(0);
}
console.log(`stImageAtelier 命名空间：${(bytes(namespace) / 1024).toFixed(1)} KB，schemaVersion=${namespace.schemaVersion ?? '?'}`);
for (const [key, value] of Object.entries(namespace)) {
  const count = Array.isArray(value) ? `，${value.length} 条` : '';
  console.log(`  ${key.padEnd(22)} ${(bytes(value) / 1024).toFixed(1).padStart(8)} KB${count}`);
}
const leaks = ['gallery', 'deletedResultIds'].filter(key => key in namespace);
console.log(leaks.length
  ? `⚠ 仍有旧字段 ${leaks.join('、')}：扩展加载后第一次读画廊会把它搬走，若长期不消失请检查 /api/files/upload 是否可用`
  : '✓ 命名空间里没有画廊数据');

if (galleryPath) {
  const gallery = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));
  const items = Array.isArray(gallery?.items) ? gallery.items : [];
  const redundant = items.filter(item => 'prompt' in item || 'resolvedPrompt' in item || 'deletedAt' in item).length;
  const deleted = items.filter(item => item.status !== 'available').length;
  console.log(`画廊索引文件：${(fs.statSync(galleryPath).size / 1024).toFixed(1)} KB，${items.length} 条，`
    + `冗余提示词字段 ${redundant} 条，非 available ${deleted} 条（期望都是 0）`);
}
