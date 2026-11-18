/* 线路记忆：哪条线路明确拒过哪个参数（高保真 input_fidelity、图片返回格式 response_format）。
   记着的在这条线路上一开始就不带，不用每张图都先被拒一遍再重发。

   2.7.1 之前只记在内存里。手机的 Safari 切到后台再回来常会把页面重新载入，一重载就忘，下一张图又要
   先被拒一次，带参考图时还得白传一遍图。现在存在这台设备的 localStorage 里，记一天：
   - 只是一份「省一次重试」的缓存，丢了、读不了都不要紧，最多多被拒一次；所以不进酒馆的设置文件，
     出图时不会因此多保存一次设置。
   - 记一天就过期：线路以后接上了这个参数，第二天会自动再带着试一次。
   - 每次查、每次改都先读一遍本机存的：两个页面同时开着，一边记下、忘掉的，另一边马上跟着。
   - 本机存不了（隐私模式、被禁用、存满了）就退回只记在这次打开页面期间，和以前一样。 */

export const LINE_MEMORY_KEY = 'stImageAtelier.lineMemory';
export const LINE_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LINES = 40;

/* 这台设备的 localStorage；有的环境（隐私模式、被禁用）连碰一下都会抛错。 */
export function deviceStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function createLineMemory({
  storage = deviceStorage(),
  now = () => Date.now(),
  ttlMs = LINE_MEMORY_TTL_MS,
  key = LINE_MEMORY_KEY,
} = {}) {
  /* 线路 → Map(参数名 → 记下的时刻)。本机存得了时每次都从那边重新读，这份只在存不了时顶上。 */
  let fallback = new Map();
  let storageWorks = Boolean(storage);

  /* 过了一天的不算；钟被往回拨了一大截（记下的时刻在一天以后）的也不算。 */
  const alive = at => Number.isFinite(at) && Math.abs(now() - at) < ttlMs;

  function parse(text) {
    const lines = new Map();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return lines;
    }
    if (!data || data.v !== 1 || !data.lines || typeof data.lines !== 'object' || Array.isArray(data.lines)) return lines;
    for (const [line, parameters] of Object.entries(data.lines)) {
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) continue;
      const kept = new Map();
      for (const [parameter, at] of Object.entries(parameters)) {
        if (typeof at === 'number' && alive(at)) kept.set(parameter, at);
      }
      if (kept.size) lines.set(line, kept);
    }
    return lines;
  }

  function read() {
    if (storageWorks) {
      try {
        const text = storage.getItem(key);
        return typeof text === 'string' && text ? parse(text) : new Map();
      } catch {
        storageWorks = false;
      }
    }
    for (const [line, parameters] of fallback) {
      for (const [parameter, at] of parameters) if (!alive(at)) parameters.delete(parameter);
      if (!parameters.size) fallback.delete(line);
    }
    return fallback;
  }

  function write(lines) {
    /* 线路太多就丢掉最早记的。 */
    if (lines.size > MAX_LINES) {
      const newest = line => Math.max(...lines.get(line).values());
      const ordered = [...lines.keys()].sort((left, right) => newest(right) - newest(left));
      for (const line of ordered.slice(MAX_LINES)) lines.delete(line);
    }
    fallback = lines;
    if (!storageWorks) return;
    try {
      if (!lines.size) {
        storage.removeItem(key);
        return;
      }
      const plain = {};
      for (const [line, parameters] of lines) plain[line] = Object.fromEntries(parameters);
      storage.setItem(key, JSON.stringify({ v: 1, lines: plain }));
    } catch {
      /* 存不进去（存满了、被禁用）：这次打开页面期间就靠 fallback 记着，不再去读本机那份旧的。 */
      storageWorks = false;
    }
  }

  /* 本机存的那份里有没有过期、坏掉的条目要清。 */
  function stale(lines) {
    if (!storageWorks) return false;
    try {
      const text = storage.getItem(key);
      if (typeof text !== 'string' || !text) return false;
      const plain = {};
      for (const [line, parameters] of lines) plain[line] = Object.fromEntries(parameters);
      return text !== JSON.stringify({ v: 1, lines: plain });
    } catch {
      return false;
    }
  }

  return {
    /* 这条线路现在还记着不认这个参数吗。 */
    has(line, parameter) {
      const lines = read();
      const found = lines.get(line)?.has(parameter) === true;
      if (!found && stale(lines)) write(lines);
      return found;
    },
    /* 这条线路刚刚点名拒了这些参数：从现在起记一天。 */
    remember(line, parameters) {
      if (!line || !parameters?.length) return;
      const lines = read();
      const known = lines.get(line) || new Map();
      for (const parameter of parameters) known.set(parameter, now());
      lines.set(line, known);
      write(lines);
    },
    /* 忘掉某个参数（人主动说「再试一次」）。presetId 给了就只忘这个预设的那几条线路。 */
    forget(parameter, presetId = null) {
      const lines = read();
      let changed = false;
      for (const [line, parameters] of lines) {
        if (presetId && !line.startsWith(`${presetId}|`)) continue;
        if (parameters.delete(parameter)) changed = true;
        if (!parameters.size) lines.delete(line);
      }
      if (changed) write(lines);
    },
    /* 现在记着的全部，诊断信息里用。 */
    snapshot() {
      const rows = [];
      for (const [line, parameters] of read()) {
        for (const [parameter, at] of parameters) rows.push({ line, parameter, learnedAt: at, expiresAt: at + ttlMs });
      }
      return rows;
    },
  };
}
