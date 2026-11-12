/* 最近几版各一句话的更新说明。更新后第一次打开页面会提示（手机上看不到控制台，这样能确认更新生效了），
   设置页最下面的「最近更新」也能展开看。
   每发一版在最前面加一条；测试会检查第一条的版本号等于当前版本，忘了加就过不了。只留最近十来条。 */
export const RELEASE_NOTES = Object.freeze([
  { version: '2.4.0', date: '2026-11-12', summary: '画廊索引拆成小文件：出一张图只上传一小份，不再整份重传' },
  { version: '2.3.0', date: '2026-11-12', summary: '面板标题旁显示版本号；更新后第一次打开会提示这次改了什么' },
  { version: '2.2.0', date: '2026-11-12', summary: '画廊加「只看这个聊天」，点开图可以「跳到所在楼层」' },
  { version: '2.1.0', date: '2026-11-12', summary: '设置页最上面加快捷开关；状态提示贴在面板底边' },
  { version: '2.0.3', date: '2026-11-12', summary: '刷新网页不再重画已有的图；从卡片上掉下来的图自动接回' },
  { version: '2.0.2', date: '2026-11-09', summary: '出图前的记录写不进酒馆时不再拦着出图' },
  { version: '2.0.0', date: '2026-11-08', summary: '聊天里每一楼只留引用，出图不再保存聊天；旧聊天可「整理旧数据」' },
  { version: '1.10.0', date: '2026-11-08', summary: '参考图组不跟 API 预设走，每个角色卡记住自己用哪一组' },
  { version: '1.9.0', date: '2026-11-07', summary: '画廊格子用缩略图，点开、下载还是原图' },
  { version: '1.8.0', date: '2026-11-05', summary: '参考图（图生图）：角色参考图、卡片上「参考重画」' },
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
