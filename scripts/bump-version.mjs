#!/usr/bin/env node
/* 一次改齐所有版本号：package.json、package-lock.json、manifest.json、Server Plugin 的
   package.json、前端常量 VERSION。CHANGELOG 仍需手写一条同版本号的记录，测试会检查。
   用法：npm run version:set 1.6.13（测试时可加 --root <目录>）。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0
  ? path.resolve(args[rootIndex + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = args.find((value, index) => !value.startsWith('--') && (rootIndex < 0 || index !== rootIndex + 1));

if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('用法：npm run version:set <主版本.次版本.修订号>，例如 1.6.13');
  process.exit(1);
}

async function updateJson(file, update) {
  const target = path.join(root, file);
  const data = JSON.parse(await fs.readFile(target, 'utf8'));
  update(data);
  await fs.writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

await updateJson('package.json', data => { data.version = version; });
await updateJson('package-lock.json', data => {
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
});
await updateJson('manifest.json', data => { data.version = version; });
await updateJson(path.join('server-plugin', 'package.json'), data => { data.version = version; });

const constants = path.join(root, 'src', 'shared', 'constants.js');
const source = await fs.readFile(constants, 'utf8');
const pattern = /export const VERSION = '[^']*';/;
if (!pattern.test(source)) throw new Error('src/shared/constants.js 里找不到 VERSION 常量');
await fs.writeFile(constants, source.replace(pattern, `export const VERSION = '${version}';`), 'utf8');

console.log(`版本号已统一改为 ${version}；别忘了在 CHANGELOG.md 顶部写一条 ## ${version} 的记录。`);
