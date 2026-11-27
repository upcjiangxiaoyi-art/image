/* 最近几版各一句话的更新说明。更新后第一次打开页面会提示（手机上看不到控制台，这样能确认更新生效了），
   设置页最下面的「最近更新」也能展开看。
   每发一版在最前面加一条；测试会检查第一条的版本号等于当前版本，忘了加就过不了。只留最近十来条。 */
export const RELEASE_NOTES = Object.freeze([
  { version: '2.10.0', date: '2026-11-27', summary: '卡片不再被酒馆主题带歪（字距、虚线框）；信息排成小标签，图片淡入' },
  { version: '2.9.0', date: '2026-11-26', summary: '图画好了却存不进酒馆时，卡片直接从线路给的链接显示，能长按存走' },
  { version: '2.8.1', date: '2026-11-26', summary: '修：带参考图时没要求线路把图片本身传回来，有的线路只给链接、图丢了' },
  { version: '2.8.0', date: '2026-11-18', summary: '设置页最下面加「复制诊断信息」，出问题时一键复制、贴出去就能查' },
  { version: '2.7.1', date: '2026-11-18', summary: '线路不认的参数记一天，刷新页面、切后台回来都不用再被拒一次' },
  { version: '2.7.0', date: '2026-11-18', summary: '看图器里左右滑就能看上一张、下一张，不用关掉再点' },
  { version: '2.6.0', date: '2026-11-18', summary: '界面重新打磨：线条图标、画廊竖图格子、看图器整张显示' },
  { version: '2.5.3', date: '2026-11-16', summary: '线路不认的参数第一张图被拒后就记住，后面的图不再重试一遍' },
  { version: '2.5.2', date: '2026-11-16', summary: '线路不认「高保真参考」时，智能重试会去掉它照常出图' },
  { version: '2.5.1', date: '2026-11-12', summary: '失败的卡片上也能「换预设」，换完点「重试」就用新预设' },
  { version: '2.5.0', date: '2026-11-12', summary: '出图后的卡片上「参考重画」旁边加「换预设」，不用进设置页' },
  { version: '2.4.0', date: '2026-11-12', summary: '画廊索引拆成小文件：出一张图只上传一小份，不再整份重传' },
]);

function parts(version) {
  return String(version || '').split('.').map(part => Number.parseInt(part, 10) || 0);
}

/* 版本号比较：a 比 b 新返回正数，一样返回 0。 */
export function compareVersions(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

/* 比 previous 新的那些说明，最新的在前。previous 不认识（空的、乱写的）就只给最新一条。 */
export function notesSince(previous, notes = RELEASE_NOTES) {
  if (!/^\d+(\.\d+)*$/.test(String(previous || ''))) return notes.slice(0, 1);
  return notes.filter(note => compareVersions(note.version, previous) > 0);
}

/* 更新后第一次打开要不要提示、提示什么。
   seen：这台设备上次见到的版本（没有就是 null）；existingUser：之前就在用（扩展设置里已经有画笺的数据）。
   全新安装不提示；版本没变不提示；从更高的版本降回来也不提示。 */
export function planUpdateNotice({ current, seen, existingUser = false, notes = RELEASE_NOTES, limit = 3 }) {
  if (seen === current) return null;
  if (!seen && !existingUser) return null;
  if (seen && compareVersions(current, seen) < 0) return null;
  const fresh = notesSince(seen, notes).filter(note => compareVersions(note.version, current) <= 0);
  const shown = fresh.slice(0, limit);
  const lines = shown.map(note => `${note.version}：${note.summary}`);
  const more = fresh.length - shown.length;
  return {
    title: `画笺已更新到 ${current}`,
    text: lines.join('；') + (more > 0 ? `；还有 ${more} 条在「设置 → 最近更新」里` : ''),
    notes: shown,
  };
}

/* 记住这台设备见过的版本。本机存储用不了（隐私模式）就只在这次页面里记着。 */
export function createVersionMemory(storage, key = 'stImageAtelier.seenVersion') {
  let fallback = null;
  return {
    read() {
      try {
        return storage?.getItem?.(key) ?? fallback;
      } catch {
        return fallback;
      }
    },
    write(version) {
      fallback = version;
      try {
        storage?.setItem?.(key, version);
      } catch {
        /* 存不了就算了，这次页面里不会重复提示。 */
      }
    },
  };
}
