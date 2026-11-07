import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../../src/shared/constants.js';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { createMemoryGalleryMetadataStore } from '../../src/ui/api/gallery-metadata-store.js';
import { createMemoryAttemptStore } from '../../src/ui/api/attempt-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('扩展主页和自动更新固定指向目标仓库', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.display_name, '画笺');
  assert.equal(manifest.homePage, 'https://github.com/phyllis-0612/st-image-atelier');
  assert.equal(manifest.auto_update, true);
});

test('两个新开关默认关闭且设置界面提供中文入口', async () => {
  assert.equal(DEFAULT_SETTINGS.enablePromptOverrideRegenerate, false);
  assert.equal(DEFAULT_SETTINGS.enableSmartRetry, false);
  const source = await fs.readFile(path.join(root, 'src/ui/pages/settings/settings.js'), 'utf8');
  assert.match(source, /允许临时修改提示词后重绘/);
  assert.match(source, /生成失败后智能重试/);
  assert.match(source, /enablePromptOverrideRegenerate: enablePromptOverrideRegenerate\.checked/);
  assert.match(source, /enableSmartRetry: enableSmartRetry\.checked/);
});

test('报错弹窗开关默认开启，设置界面有中文入口，直连设置可持久化', async () => {
  assert.equal(DEFAULT_SETTINGS.enableErrorPopup, true);
  const source = await fs.readFile(path.join(root, 'src/ui/pages/settings/settings.js'), 'utf8');
  assert.match(source, /field\('报错弹窗', enableErrorPopup\)/);
  assert.match(source, /enableErrorPopup: enableErrorPopup\.checked/);
  const extensionSettings = { stImageAtelier: { settings: { enabled: true } } };
  const create = () => createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  assert.equal((await create().getSettings()).enableErrorPopup, true, '旧设置自动补为开启');
  await create().updateSettings({ enableErrorPopup: false });
  assert.equal((await create().getSettings()).enableErrorPopup, false);
});

test('两个新开关在直连设置中持久化，旧设置自动补默认值', async () => {
  const extensionSettings = { stImageAtelier: { settings: { enabled: true } } };
  const galleryStore = createMemoryGalleryMetadataStore();
  const create = () => createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore,
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  let client = create();
  let settings = await client.getSettings();
  assert.equal(settings.enablePromptOverrideRegenerate, false);
  assert.equal(settings.enableSmartRetry, false);
  await client.updateSettings({
    enablePromptOverrideRegenerate: true,
    enableSmartRetry: true,
  });
  client = create();
  settings = await client.getSettings();
  assert.equal(settings.enablePromptOverrideRegenerate, true);
  assert.equal(settings.enableSmartRetry, true);
});

test('全量元数据接口不受旧画廊每页 30 张限制', async () => {
  const gallery = Array.from({ length: 35 }, (_, index) => ({
    resultId: `result-${index}`,
    status: 'available',
    prompt: `prompt ${index}`,
    createdAt: new Date(Date.parse('2026-09-07T00:00:00.000Z') - index * 1000).toISOString(),
  }));
  const client = createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings: { stImageAtelier: { gallery } },
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  assert.equal((await client.gallery()).items.length, 30);
  assert.equal((await client.galleryMetadata()).items.length, 35);
});

test('消息被重 roll 或删掉后，旧标签的生图在发请求之前就停下，报 TAG_NOT_FOUND', async t => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('不该发请求'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const client = createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings: { stImageAtelier: { settings: { enabled: true } } },
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    attemptStore: createMemoryAttemptStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  await assert.rejects(
    client.generate({ tagId: 'gone', attemptId: 'auto:gone', requestMode: 'auto', prompt: 'x', parameters: {} }),
    error => error.code === 'TAG_NOT_FOUND' && /重新生成或改动/.test(error.message),
  );
  assert.equal(fetches, 0);
});

test('版本号只有一个：package.json、lock、manifest、Server Plugin、前端常量和 CHANGELOG 顶部一致', async () => {
  const read = file => fs.readFile(path.join(root, file), 'utf8');
  const { version } = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  const { VERSION } = await import('../../src/shared/constants.js');
  const versions = {
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages[''].version,
    'manifest.json': JSON.parse(await read('manifest.json')).version,
    'server-plugin/package.json': JSON.parse(await read('server-plugin/package.json')).version,
    'src/shared/constants.js VERSION': VERSION,
    'CHANGELOG.md 顶部': /^## (\d+\.\d+\.\d+)/m.exec(await read('CHANGELOG.md'))?.[1],
  };
  for (const [where, value] of Object.entries(versions)) assert.equal(value, version, where);
  for (const file of ['src/ui/api/direct-client.js', 'server-plugin/src/routes/index.js']) {
    assert.doesNotMatch(await read(file), /version: '\d+\.\d+\.\d+'/, `${file} 不再写死版本号`);
  }
});

test('npm run version:set 一次改齐所有版本号', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-version-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const file of ['package.json', 'package-lock.json', 'manifest.json', 'server-plugin/package.json', 'src/shared/constants.js']) {
    await fs.mkdir(path.dirname(path.join(temp, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(temp, file));
  }
  await promisify(execFile)(process.execPath, [path.join(root, 'scripts', 'bump-version.mjs'), '9.8.7', '--root', temp]);
  const read = file => fs.readFile(path.join(temp, file), 'utf8');
  assert.equal(JSON.parse(await read('package.json')).version, '9.8.7');
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(lock.version, '9.8.7');
  assert.equal(lock.packages[''].version, '9.8.7');
  assert.equal(JSON.parse(await read('manifest.json')).version, '9.8.7');
  assert.equal(JSON.parse(await read('server-plugin/package.json')).version, '9.8.7');
  assert.match(await read('src/shared/constants.js'), /export const VERSION = '9\.8\.7';/);
  await assert.rejects(
    promisify(execFile)(process.execPath, [path.join(root, 'scripts', 'bump-version.mjs'), 'v2', '--root', temp]),
    '版本号格式不对时拒绝执行',
  );
});

test('设置页有参考图入口，画质说明包含 2.6', async () => {
  const source = await fs.readFile(path.join(root, 'src/ui/pages/settings/settings.js'), 'utf8');
  assert.match(source, /参考图（图生图，每个预设最多 4 张）/);
  assert.match(source, /api\.addReference\(/);
  assert.match(source, /api\.removeReference\(/);
  assert.match(source, /每张图自动带上参考图/);
  assert.match(source, /input_fidelity: high/);
  assert.match(source, /gpt-image-2\.5 \/ 2\.6/);
  assert.match(source, /这个预设的，最多 4 张/, '参考图标题写明是哪个预设的');
  assert.match(source, /api\.replaceReference\(/, '缩略图下面能原位换一张');
  assert.match(source, /action\('换一张'/, '「换一张」是写着字的按钮，不是角上的小 ×');
  assert.match(source, /action\('删除', async \(\) => run\(remove/, '「删除」也是写着字的按钮');
  assert.doesNotMatch(source, /stia-reference-item__remove/, '不再用缩略图角上那个 24px 的 ×');
});

test('触屏设备上不做毛玻璃：每一处 backdrop-filter 都在触屏媒体查询里关掉', async () => {
  const css = await fs.readFile(path.join(root, 'src/ui/styles/atelier.css'), 'utf8');
  const block = /@media \(hover: none\) and \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  assert.match(block, /backdrop-filter: none/);
  for (const selector of ['.stia-overlay', '.stia-panel > header', '.stia-prompt-override', '.stia-image-viewer__toolbar']) {
    assert.ok(block.includes(selector), `${selector} 在触屏上关掉毛玻璃`);
  }
  const blurred = css.split('\n').filter(line => /backdrop-filter: blur/.test(line)).length;
  assert.equal(blurred, 4, '新加的毛玻璃也要进触屏关闭列表');
});

test('卡片、画廊、参考图的图片都异步解码', async () => {
  for (const file of ['src/ui/renderer/card.js', 'src/ui/pages/gallery/gallery.js', 'src/ui/pages/settings/settings.js']) {
    assert.match(await fs.readFile(path.join(root, file), 'utf8'), /\.decoding = 'async'/, file);
  }
});

test('画廊缩略图：格子用 thumbnailUrl、看图器用 fileUrl，设置页有一次补全的入口，README 写明原图不动', async () => {
  const gallery = await fs.readFile(path.join(root, 'src/ui/pages/gallery/gallery.js'), 'utf8');
  assert.match(gallery, /image\.src = tileUrl\(result\)/, '格子用缩略图');
  assert.match(gallery, /src: api\.fileUrl\(result\.resultId\)/, '看图器用原图');
  assert.match(gallery, /link\.href = api\.downloadUrl\(item\.resultId\)/, '下载用原图');
  const settings = await fs.readFile(path.join(root, 'src/ui/pages/settings/settings.js'), 'utf8');
  assert.match(settings, /api\.backfillThumbnails\(/);
  assert.match(settings, /补全画廊缩略图/);
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /缩略图/);
  assert.match(readme, /原图/);
});
