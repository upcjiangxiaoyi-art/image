#!/usr/bin/env node
/* 检查酒馆 settings.json 里 Image Atelier 命名空间的体积构成，以及画廊索引文件的健康度。
   用法：node scripts/inspect-settings.mjs /path/to/data/<user>/settings.json [user/files/st-image-atelier-gallery.json]
   期望（1.6.2 起）：命名空间里没有 gallery / deletedResultIds，只有设置项；
   画廊记录在 user/files/st-image-atelier-gallery.json，格式 { schemaVersion, results: { [id]: record } }。 */
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
  const records = gallery?.results && typeof gallery.results === 'object'
    ? Object.values(gallery.results)
    : (Array.isArray(gallery?.items) ? gallery.items : []);
  const format = gallery?.results ? '上游格式（results 对象）' : (Array.isArray(gallery?.items) ? 'fork 1.6.2 格式（items 数组，下次加载会自动转换）' : '未知格式');
  const redundant = records.filter(item => 'promptSnapshot' in item || 'resolvedPrompt' in item || 'deletedAt' in item).length;
  const notAvailable = records.filter(item => item.status !== 'available').length;
  console.log(`画廊索引文件：${(fs.statSync(galleryPath).size / 1024).toFixed(1)} KB，${records.length} 条，${format}`);
  console.log(`  冗余提示词字段 ${redundant} 条，非 available ${notAvailable} 条（期望都是 0）`);
}
