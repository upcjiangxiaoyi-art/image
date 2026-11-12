import { DirectError } from './openai-direct.js';

/* 把一大份 { [id]: 记录 } 拆成「一份清单 + 若干小文件（分片）」存进酒馆的用户文件。
   以前整份是一个文件，改一条记录就要把整份重新上传一遍（画廊一千张图就是十几 MB）；拆开以后改哪条只重写
   它所在的那一个分片，分片有大小上限，所以每次写的量和总共存了多少无关。

   两种状态：
   - legacy：服务器上还没有清单，旧的整份文件说了算。读、写都照旧（整份）；同时在后台把分片一个个传上去，
     全部传完才写清单。清单写上去那一刻起换成 segmented。中途页面关了、哪一步失败了，下次打开从头再来
     （分片名是固定的 m0001、m0002…，重来就是覆盖），这期间一切照旧工作——拆分不成功不影响使用。
   - segmented：清单和分片说了算，旧文件留在原地不再动（当备份）。

   几条保证：
   - 出图那条路上只有「上传改过的分片」这一种请求。清单只在后台改：尾巴分片满了，先在清单上登记下一个，
     登记成功之后新记录才往里放（登记好之前还放在原来那个里，稍微超一点没关系）。所以不会出现
     「记录写进了一个清单上没有的分片」。清单上有、文件还不存在的分片当成空的。
   - 改清单是「读服务器上现在的清单 → 加上我新开的、去掉我清空的 → 写回」，不是拿手里的旧清单盖上去：
     别的设备新开的分片不会被开了很久的旧页面挤掉。
   - 写分片之前先看一眼服务器上那份的文件头：大小变了说明别的设备动过，把它读回来，
     别的设备加进去、我不认识的记录原样带上。
   - 读分片带本机缓存的 ETag，没变的不重新下载。
   - 两台设备同时第一次打开新版、都动手拆：拆出来的 m 开头的分片只由旧文件的内容决定（按时间排好依次装），
     两台写出来的一模一样，谁后写都无妨；拆的过程中和拆完以后新来的记录一律进各自新开的分片（名字带随机数），
     不往 m 分片里加。后拆完的那台每传一批之前先看一眼，服务器上已经有清单就不再拆，改用现成的清单和分片。 */

const SCHEMA_VERSION = 1;
/* 读分片同时发几个请求。HTTP/1.1 下浏览器自己会按每个站点 6 条连接排队，HTTP/2 下这些可以一起走。 */
const READ_POOL = 10;
const WRITE_POOL = 4;
const MIGRATE_POOL = 3;
const EMPTY_BYTES = 40;
const encoder = new TextEncoder();
const byteLength = text => encoder.encode(text).length;
const SEGMENT_ID = /^[A-Za-z0-9]{1,40}$/;
const MIGRATED_ID = /^m(\d{4,})$/;
/* 隔了这么久没碰过的分片，再写它时：写完回头确认它还在清单上（连着出图时不会每张都去确认；
   开了很久的页面隔一阵再用，第一次写就会确认）。从 ETag 里读不出文件大小的环境里，
   「写之前看一眼有没有别人加的记录」也按这个间隔来。 */
export const SEGMENT_RECHECK_INTERVAL_MS = 30_000;
/* 拆分后这么多天里，每次打开页面看一眼旧文件有没有被没刷新的旧版页面改过，改过就把新加的记录接过来。 */
export const LEGACY_RECHECK_MS = 14 * 24 * 60 * 60 * 1000;
const LEGACY_CLOCK_SLACK_MS = 5 * 60 * 1000;
/* 拆分失败后隔这么久、等下一次有东西要写时再试。 */
const MIGRATE_RETRY_MS = 60_000;
/* 平常的写入最多等「看一眼服务器上那份」这么久；等不到就先写，回音到了再补。 */
export const REFRESH_WAIT_MS = 3000;
/* expedite() 之后这么久以内的写入不等：页面要转入后台了，请求必须当场发出去。 */
const URGENT_WINDOW_MS = 2000;

/* 同时最多跑 limit 个；前 limit 个在同一拍里发出去（页面转入后台前要求请求当场发出）。返回出过的错。 */
export function runPool(tasks, limit, { stopOnError = false } = {}) {
  return new Promise(resolve => {
    const errors = [];
    let next = 0;
    let active = 0;
    const pump = () => {
      while (active < limit && next < tasks.length && !(stopOnError && errors.length)) {
        const task = tasks[next];
        next += 1;
        active += 1;
        Promise.resolve().then(task).then(null, error => { errors.push(error); }).then(() => {
          active -= 1;
          pump();
        });
      }
      if (!active && (next >= tasks.length || (stopOnError && errors.length))) resolve(errors);
    };
    pump();
  });
}

/* 酒馆（express 的 send）的 ETag 是 W/"大小-修改时间"，都是十六进制：从里面读出文件多少字节。别的格式读不出就是 null。 */
export function bytesFromEtag(etag) {
  const match = /^(?:W\/)?"([0-9a-f]+)-[0-9a-f]+"$/i.exec(String(etag || ''));
  return match ? Number.parseInt(match[1], 16) : null;
}

function defaultSegmentId() {
  const random = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `s${Date.now().toString(36)}${random}`;
}

export function createSegmentedBackend({
  files,
  label = '数据',
  manifestFile,
  segmentPrefix,
  legacyFile,
  recordsKey,
  legacyRecords,
  idOf,
  orderOf = () => '',
  maxSegmentBytes = 160_000,
  maxSegmentRecords = 120,
  passThroughForeign = false,
  recheckIntervalMs = SEGMENT_RECHECK_INTERVAL_MS,
  legacyRecheckMs = LEGACY_RECHECK_MS,
  /* 读分片遇到网络断了、服务器 5xx：隔这么久重试，试完还不行才算初始化失败。 */
  retryDelaysMs = [],
  refreshWaitMs = REFRESH_WAIT_MS,
  now = () => Date.now(),
  newSegmentId = defaultSegmentId,
  warn = (...args) => console.warn(...args),
}) {
  const segmentFile = id => `${segmentPrefix}${id}.json`;

  /* 每次 readDocument() 重来一遍；generation 变了，上一轮还在跑的后台活就自己停下。 */
  let generation = 0;
  let mode = 'unloaded';
  let live = null;
  let segments = new Map();
  let tail = null;
  let assignment = new Map();
  let removedIds = new Set();
  let changedIds = new Set();
  let mine = new Set();
  let pendingAdds = new Set();
  let wantSpare = false;
  let manifestDirty = false;
  let legacyInfo = null;
  let manifestChain = Promise.resolve();
  let manifestQueued = false;
  let background = Promise.resolve();
  let migrating = false;
  let migrateFailedAt = 0;
  let lastError = null;
  /* 这台酒馆的 ETag 里是不是带着文件大小（express 的 send 是「大小-修改时间」）：true 才靠看文件头判断
     分片有没有被别人动过。null = 还没见过能对上的，false = 对不上（中间有代理改过 ETag）。 */
  let sizeEtags = null;
  /* 拆分重来时，服务器上已经有的分片文件（上次传了一半留下的）：内容一样就不重传。 */
  let leftovers = new Set();
  let urgentUntil = 0;
  const refreshes = new Set();

  function makeSegment(id, { exists = false, size = EMPTY_BYTES, bytes = null } = {}) {
    return {
      id,
      ids: new Set(),
      /* 序列化后大概多少字节：读进来、写上去时是准的，中间加记录时往上累加。 */
      size,
      /* 服务器上这个文件现在确切多少字节（不知道就是 null），垫空格用。 */
      bytes,
      /* version：内容每变一次加一；synced：已经写上服务器的是哪一版。exists：服务器上有没有这个文件。 */
      version: 0,
      synced: 0,
      exists,
      /* 上一次确认它在清单上是什么时候。 */
      confirmedAt: -Infinity,
      chain: Promise.resolve(),
      /* 服务器上这个分片里、我不认识的记录（别的设备加的），写的时候原样带上。 */
      foreign: new Map(),
      lastSyncAt: 0,
      lastWriteAt: 0,
      refreshing: null,
      /* 这一轮改动（从上次写完到下次写）里已经看过服务器上那份了：一轮只看一次。 */
      checked: false,
    };
  }

  function appendSegment(segment) {
    segments.set(segment.id, segment);
    tail = segment;
    return segment;
  }

  function reset() {
    generation += 1;
    mode = 'unloaded';
    live = null;
    segments = new Map();
    tail = null;
    assignment = new Map();
    removedIds = new Set();
    changedIds = new Set();
    mine = new Set();
    pendingAdds = new Set();
    wantSpare = false;
    manifestDirty = false;
    manifestQueued = false;
    legacyInfo = null;
    migrating = false;
    migrateFailedAt = 0;
    lastError = null;
    sizeEtags = null;
    leftovers = new Set();
  }

  const recordBytes = (id, record) => byteLength(JSON.stringify(record)) + byteLength(String(id)) + 4;
  const isEmpty = segment => !segment.ids.size && !segment.foreign.size;
  const isFull = (segment, extra = 0) => segment.ids.size >= maxSegmentRecords
    || (segment.ids.size > 0 && segment.size + extra > maxSegmentBytes);

  /* 一份刚读到的正文：{ size: 确切多少字节, bytes: ETag 里的大小对得上就是它，对不上是 null }。 */
  function measure(text, etag) {
    const size = byteLength(text);
    const fromEtag = bytesFromEtag(etag);
    if (fromEtag === size) sizeEtags = true;
    else if (etag) sizeEtags = false;
    return { size, bytes: fromEtag === size ? size : null };
  }

  async function retrying(work) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        const transient = !(error instanceof DirectError) || !error.status || error.status >= 500;
        if (!transient || attempt >= retryDelaysMs.length) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
  }

  function parseJson(text, name) {
    try {
      return JSON.parse(text);
    } catch {
      throw new DirectError('LOCAL_SAVE_FAILED', `${label}的文件 ${name} 不是有效 JSON`);
    }
  }

  function recordsOf(value) {
    const map = value?.[recordsKey];
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  }

  /* 服务器上的清单：{ segments, legacy }；没有返回 null。 */
  async function readManifest() {
    const result = await files.read(manifestFile);
    if (result.status === 404) return null;
    /* 顺便看一眼这台酒馆的 ETag 里带不带文件大小。 */
    measure(result.text, result.etag);
    const value = parseJson(result.text, manifestFile);
    if (!Array.isArray(value?.segments)) {
      throw new DirectError('LOCAL_SAVE_FAILED', `${label}的清单 ${manifestFile} 格式不对`);
    }
    return {
      segments: [...new Set(value.segments.filter(id => typeof id === 'string' && SEGMENT_ID.test(id)))],
      legacy: value.legacy && typeof value.legacy === 'object' ? value.legacy : null,
    };
  }

  async function loadSegments(list, records) {
    const loaded = new Map();
    const errors = await runPool(list.map(id => async () => {
      const name = segmentFile(id);
      const result = await retrying(() => files.read(name, { cached: true }));
      if (result.status === 404) {
        loaded.set(id, { exists: false, map: {} });
        return;
      }
      const map = recordsOf(parseJson(result.text, name));
      if (!result.cached) files.remember?.(name, result);
      loaded.set(id, { exists: true, map, ...measure(result.text, result.etag) });
    }), READ_POOL, { stopOnError: true });
    if (errors.length) throw errors[0];
    const at = now();
    for (const id of list) {
      const entry = loaded.get(id);
      const segment = appendSegment(makeSegment(id, entry));
      segment.lastSyncAt = at;
      for (const [recordId, record] of Object.entries(entry.map)) {
        /* 同一条记录出现在两个分片里（不该有）：认前面那个；后面那份等那个分片下次重写时自然去掉。 */
        if (assignment.has(recordId)) continue;
        assignment.set(recordId, id);
        segment.ids.add(recordId);
        records[recordId] = record;
      }
    }
    files.forget?.(segmentPrefix, new Set(list.map(segmentFile)));
  }

  function migratedId(number) {
    return `m${String(number).padStart(4, '0')}`;
  }

  /* 旧的整份文件按时间排好，依次装进 m0001、m0002…：同一份文件每次分出来都一样，重来就是覆盖。 */
  function partition(source, records) {
    const entries = [];
    for (const record of source) {
      const id = idOf(record);
      if (!id || records[id] !== undefined) continue;
      records[id] = record;
      entries.push({ id, order: String(orderOf(record) || ''), size: recordBytes(id, record) });
    }
    entries.sort((left, right) => {
      if (left.order !== right.order) return left.order < right.order ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    let number = 0;
    for (const entry of entries) {
      if (!tail || isFull(tail, entry.size)) {
        number += 1;
        mine.add(appendSegment(makeSegment(migratedId(number))).id);
      }
      tail.ids.add(entry.id);
      tail.size += entry.size;
      assignment.set(entry.id, tail.id);
    }
    for (const segment of segments.values()) segment.version = 1;
  }

  /* 已经拆分过了，但旧文件之后又被改过（没刷新的旧版页面还在往里写）：把拆分之后新加的记录接过来。 */
  async function recheckLegacy(records) {
    const importedAt = Date.parse(legacyInfo?.importedAt || '');
    if (!legacyInfo?.etag || !Number.isFinite(importedAt) || now() - importedAt > legacyRecheckMs) return;
    const head = await files.head(legacyFile);
    if (!head || head.status !== 200 || !head.etag || head.etag === legacyInfo.etag) return;
    let source;
    try {
      const result = await files.read(legacyFile);
      if (result.status !== 200) return;
      source = legacyRecords(parseJson(result.text, legacyFile));
    } catch (error) {
      warn(`[画笺] 核对旧的${label}文件失败，下次打开再试`, error);
      return;
    }
    for (const record of source) {
      const id = idOf(record);
      const createdAt = Date.parse(orderOf(record) || '');
      if (!id || records[id] !== undefined || !(createdAt > importedAt - LEGACY_CLOCK_SLACK_MS)) continue;
      records[id] = record;
    }
    legacyInfo = { ...legacyInfo, etag: head.etag };
    manifestDirty = true;
  }

  async function readDocument() {
    reset();
    const generationAtStart = generation;
    const records = {};
    const manifest = await readManifest();
    if (manifest) {
      legacyInfo = manifest.legacy;
      await loadSegments(manifest.segments, records);
      await recheckLegacy(records);
      mode = 'segmented';
    } else {
      const legacy = await files.read(legacyFile);
      const source = legacy.status === 200 ? legacyRecords(parseJson(legacy.text, legacyFile)) : [];
      if (legacy.status === 200) {
        measure(legacy.text, legacy.etag);
        legacyInfo = { file: legacyFile, importedAt: new Date(now()).toISOString(), etag: legacy.etag || '' };
      }
      partition(source, records);
      mode = 'legacy';
    }
    if (generationAtStart !== generation) throw new Error(`${label}正在重新读取`);
    return { schemaVersion: SCHEMA_VERSION, [recordsKey]: records };
  }

  /* 新记录放哪个分片。 */
  function segmentFor(size) {
    if (mode !== 'segmented') {
      /* 清单还没写上去。拆出来的 m 分片不往里加（它们的内容只由旧文件决定），这期间新来的记录放进
         这次页面自己新开的分片，清单最后一起写。 */
      if (tail && !MIGRATED_ID.test(tail.id) && !isFull(tail, size)) return tail;
      const segment = appendSegment(makeSegment(newSegmentId()));
      mine.add(segment.id);
      return segment;
    }
    if (tail && !isFull(tail, size)) return tail;
    if (!tail) {
      /* 一个分片都没有（清单是空的）：只能先开一个用着，清单随后补上。 */
      const segment = appendSegment(makeSegment(newSegmentId()));
      mine.add(segment.id);
      pendingAdds.add(segment.id);
      return segment;
    }
    /* 尾巴满了：让后台去清单上登记下一个，登记好之前先放在现在这个里。 */
    wantSpare = true;
    return tail;
  }

  function touch(segment) {
    segment.version += 1;
    refreshForeign(segment);
  }

  /* 把内存里的文档和分片的归属对一遍：新出现的记录分配分片，不见了的从分片里去掉，改过内容的标上要重写。
     成员是整份扫一遍对出来的（几千次查表，零点几毫秒），不依赖 noteChange 有没有漏报。 */
  function reconcile() {
    if (!live) return;
    const map = live[recordsKey];
    for (const [id, segmentId] of assignment) {
      if (map[id] !== undefined) continue;
      assignment.delete(id);
      removedIds.add(id);
      const segment = segments.get(segmentId);
      if (segment) {
        segment.ids.delete(id);
        touch(segment);
      }
    }
    for (const id of Object.keys(map)) {
      if (assignment.has(id)) continue;
      const size = recordBytes(id, map[id]);
      const segment = segmentFor(size);
      assignment.set(id, segment.id);
      segment.ids.add(id);
      segment.size += size;
      removedIds.delete(id);
      changedIds.delete(id);
      touch(segment);
    }
    for (const id of changedIds) {
      const segment = segments.get(assignment.get(id));
      if (segment) touch(segment);
    }
    changedIds.clear();
  }

  function dirtySegments() {
    return [...segments.values()].filter(segment => segment.version !== segment.synced);
  }

  function uploadSegment(segment) {
    const run = segment.chain.then(async () => {
      if (segment.version === segment.synced) return;
      if (segment.refreshing && now() >= urgentUntil) {
        /* 「看一眼服务器上那份」还没回来：等它（它通常早在合并写的那一两秒里就回来了），
           这样写上去的一定带着别的设备加的记录，不会先盖掉再补。页面要转入后台时不等。 */
        let timer;
        await Promise.race([
          segment.refreshing,
          new Promise(resolve => { timer = setTimeout(resolve, refreshWaitMs); }),
        ]);
        clearTimeout(timer);
        if (segment.version === segment.synced) return;
      }
      const version = segment.version;
      if (isEmpty(segment) && !segment.exists) {
        segment.synced = version;
        return;
      }
      const map = live[recordsKey];
      const out = {};
      for (const [id, record] of segment.foreign) {
        if (!assignment.has(id) && !removedIds.has(id)) out[id] = record;
      }
      for (const id of segment.ids) {
        if (map[id] !== undefined) out[id] = map[id];
      }
      const text = JSON.stringify({ schemaVersion: SCHEMA_VERSION, [recordsKey]: out });
      const name = segmentFile(segment.id);
      if (leftovers.has(name) && !segment.exists) {
        /* 上次拆了一半留下的同名文件：读回来和要写的一模一样就不重传（下载比上传省得多）。 */
        const existing = await files.read(name).catch(() => null);
        if (existing?.status === 200 && existing.text.trimEnd() === text) {
          segment.size = byteLength(existing.text);
          segment.bytes = sizeEtags === false ? null : segment.size;
          segment.synced = version;
          segment.exists = true;
          segment.lastSyncAt = now();
          return;
        }
      }
      segment.lastWriteAt = now();
      segment.checked = false;
      const written = await files.write(name, text, { avoidSize: segment.bytes });
      segment.size = written;
      segment.bytes = sizeEtags === false ? null : written;
      segment.synced = version;
      segment.exists = true;
      segment.lastSyncAt = now();
      if (mode === 'segmented' && now() - segment.confirmedAt >= recheckIntervalMs) {
        /* 隔了一阵才又往这个分片写：回头确认一下它还在清单上。开了很久的页面手里的清单可能过时了
           （登记被别的页面同时写清单盖掉了、这个分片被别的设备清空后摘掉了），不在就补回去。 */
        segment.confirmedAt = now();
        pendingAdds.add(segment.id);
      }
    });
    segment.chain = run.catch(() => {});
    return run;
  }

  async function flushSegments(limit = WRITE_POOL) {
    reconcile();
    /* 要登记下一个分片的话现在就去，和上传同时进行；上传完再看一次（确认、摘掉清空的）。 */
    maybeSyncManifest();
    const errors = await runPool(dirtySegments().map(segment => () => uploadSegment(segment)), limit);
    maybeSyncManifest();
    if (errors.length) throw errors[0];
  }

  /* 改分片之前看一眼服务器上的那份有没有别人动过。不挡写：写照常在合并写的时间到了就发，
     这里先回来的话写的时候就把别人加的记录带上；后回来、又发现写已经发出去了，就补写一次。
     先只看文件头（几百字节）：酒馆的 ETag 里有文件大小，和我上次读到、写上去的一样大就是没人动过，到此为止；
     不一样才把整份读回来，把里面我不认识的记录（别的设备加的）记下。
     ETag 里读不出大小的环境退回到「隔一阵没碰过才整份读一次」。 */
  function refreshForeign(segment) {
    if (!passThroughForeign || mode !== 'segmented' || !segment.exists || segment.refreshing || segment.checked) return;
    /* 还不知道这台酒馆的 ETag 带不带大小时也先看文件头：对得上就是带，对不上就整份读回来、顺便弄清楚。 */
    const byHeader = sizeEtags !== false && segment.bytes !== null;
    if (!byHeader && now() - segment.lastSyncAt < recheckIntervalMs) return;
    segment.checked = true;
    const startedAt = now();
    const generationAtStart = generation;
    const run = (async () => {
      try {
        const name = segmentFile(segment.id);
        if (byHeader) {
          const head = await files.head(name);
          if (generationAtStart !== generation || !head) return;
          if (head.status === 200 && bytesFromEtag(head.etag) === segment.bytes) {
            sizeEtags = true;
            segment.lastSyncAt = now();
            return;
          }
          /* 文件没了：被别的设备清空、摘掉了。接下来往里写完一定回头确认它在清单上。 */
          if (head.status === 404) segment.confirmedAt = -Infinity;
        }
        const result = await files.read(name, { cached: true });
        if (generationAtStart !== generation || result.status !== 200) return;
        const remote = recordsOf(parseJson(result.text, name));
        const foreign = new Map();
        for (const [id, record] of Object.entries(remote)) {
          if (!assignment.has(id) && !removedIds.has(id)) foreign.set(id, record);
        }
        const discovered = [...foreign.keys()].some(id => !segment.foreign.has(id));
        segment.foreign = foreign;
        segment.lastSyncAt = now();
        /* 这期间我自己的写要是已经落地，bytes 早就是我写的那版了；没写过就记下服务器上现在多大。 */
        const measured = measure(result.text, result.etag);
        if (segment.lastWriteAt < startedAt) segment.bytes = measured.bytes;
        if (discovered && segment.lastWriteAt >= startedAt) {
          segment.version += 1;
          runInBackground(() => flushSegments());
        }
      } catch {
        /* 看不到就照常写。 */
      } finally {
        segment.refreshing = null;
        refreshes.delete(run);
      }
    })();
    segment.refreshing = run;
    refreshes.add(run);
  }

  /* 清空了、空的那一版已经写上去、又不是尾巴的分片：可以从清单上摘掉。
     清单上有、文件还不存在的不摘——那可能是别的页面刚登记、还没来得及用的。 */
  function removable() {
    return [...segments.values()].filter(segment => segment !== tail
      && segment.exists && isEmpty(segment) && segment.version === segment.synced);
  }

  function maybeSyncManifest() {
    if (mode !== 'segmented' || manifestQueued) return;
    if (!wantSpare && !pendingAdds.size && !manifestDirty && !removable().length) return;
    manifestQueued = true;
    const generationAtStart = generation;
    manifestChain = manifestChain.then(async () => {
      manifestQueued = false;
      if (generationAtStart !== generation) return;
      try {
        await syncManifest();
      } catch (error) {
        lastError = error;
        warn(`[画笺] 更新${label}的清单失败，下次写入时再试`, error);
        return;
      }
      /* 这一趟跑着的时候又排进来的（确认、登记），接着做。 */
      maybeSyncManifest();
    });
  }

  /* 读服务器上现在的清单，加上我新开的、去掉我清空的，写回去。creating：服务器上还没有清单，第一次写。 */
  async function syncManifest({ creating = false } = {}) {
    const adds = [...pendingAdds];
    const wasDirty = manifestDirty;
    let base = [];
    let remoteLegacy = null;
    let missing = false;
    if (!creating) {
      const remote = await readManifest();
      if (remote) {
        base = remote.segments;
        remoteLegacy = remote.legacy;
      } else {
        /* 清单不见了（被删了）：按手里有的重建。 */
        missing = true;
        base = [...segments.keys()].filter(id => !mine.has(id) || segments.get(id).exists);
      }
    }
    /* 摘掉之前把服务器上那份读回来确认真的是空的：里面要是有记录（别的设备刚加的、我没来得及看见的），
       就不摘、不删，记下来以后原样带着。 */
    const drop = [];
    for (const segment of removable()) {
      const name = segmentFile(segment.id);
      const result = await files.read(name).catch(() => null);
      if (!result) continue;
      if (result.status === 200) {
        const remote = Object.entries(recordsOf(parseJson(result.text, name)));
        if (remote.length) {
          const foreign = remote.filter(([id]) => !assignment.has(id) && !removedIds.has(id));
          if (foreign.length) segment.foreign = new Map(foreign);
          continue;
        }
      }
      if (segment !== tail && isEmpty(segment) && segment.version === segment.synced) drop.push(segment);
    }
    const dropIds = new Set(drop.map(segment => segment.id));
    const next = base.filter(id => !dropIds.has(id));
    const listed = new Set(next);
    for (const id of creating ? segments.keys() : new Set([...adds, ...mine])) {
      const segment = segments.get(id);
      if (!segment || listed.has(id) || dropIds.has(id)) continue;
      if (segment.ids.size || segment.exists || segment === tail) {
        next.push(id);
        listed.add(id);
      }
    }
    const needSpare = !tail || isFull(tail);
    /* 第一次写清单时，尾巴要是个 m 分片就顺手登记一个新的：以后的新记录不往 m 分片里加。 */
    const spare = (wantSpare && needSpare) || (creating && (needSpare || MIGRATED_ID.test(tail.id)))
      ? newSegmentId()
      : null;
    if (spare) next.push(spare);
    const changed = creating || missing || wasDirty
      || next.length !== base.length || next.some((id, index) => id !== base[index]);
    if (changed) {
      /* 旧文件的记号：这次是我改的（刚拆完、刚接过旧文件里后加的记录）就用我的；不然以服务器上的为准——
         别的设备可能刚更新过它，开得早的页面不能拿手里的旧记号盖回去。 */
      const legacy = creating || wasDirty ? (legacyInfo || remoteLegacy) : (remoteLegacy || legacyInfo);
      if (legacy && legacy !== legacyInfo && !wasDirty) legacyInfo = legacy;
      await files.write(manifestFile, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        segments: next,
        ...(legacy ? { legacy } : {}),
      }));
    }
    for (const id of adds) pendingAdds.delete(id);
    if (wasDirty) manifestDirty = false;
    if (spare || !needSpare) wantSpare = false;
    for (const segment of drop) {
      segments.delete(segment.id);
      mine.delete(segment.id);
      if (segment.exists) files.remove(segmentFile(segment.id));
    }
    if (spare) mine.add(appendSegment(makeSegment(spare)).id);
    lastError = null;
  }

  function runInBackground(work) {
    const generationAtStart = generation;
    background = background.then(async () => {
      if (generationAtStart !== generation) return;
      try {
        await work(generationAtStart);
      } catch (error) {
        lastError = error;
        warn(`[画笺] ${label}后台写入失败，下次再试`, error);
      }
    });
    return background;
  }

  /* 我还在拆的时候别的设备已经拆完、写好清单了：不再拆，也不拿自己的清单去盖它的，直接改用它的清单和分片。
     我这边内存里的记录和它分片里的对一遍：
     - 两边都有、内容一样：不动；内容不一样：以我这边的为准，那个分片重写；
     - 我这边有、它没有（拆的过程中我新画的）：当新记录放进尾巴分片；
     - 它有、我这边没有：我删掉的就从分片里去掉，别的（它拆完以后新画的）原样留着。 */
  async function adoptServerLayout(manifest) {
    const saved = { segments, tail, assignment, mine, pendingAdds, wantSpare, legacyInfo };
    const snapshot = {};
    try {
      segments = new Map();
      tail = null;
      assignment = new Map();
      mine = new Set();
      pendingAdds = new Set();
      wantSpare = false;
      await loadSegments(manifest.segments, snapshot);
    } catch (error) {
      ({ segments, tail, assignment, mine, pendingAdds, wantSpare, legacyInfo } = saved);
      throw error;
    }
    legacyInfo = manifest.legacy;
    const map = live[recordsKey];
    for (const [id, segmentId] of [...assignment]) {
      const segment = segments.get(segmentId);
      if (map[id] === undefined) {
        assignment.delete(id);
        segment.ids.delete(id);
        if (removedIds.has(id)) segment.version += 1;
        else segment.foreign.set(id, snapshot[id]);
      } else if (JSON.stringify(map[id]) !== JSON.stringify(snapshot[id])) {
        segment.version += 1;
      }
    }
    for (const segment of segments.values()) segment.confirmedAt = now();
    mode = 'segmented';
    lastError = null;
    await flushSegments();
  }

  /* 把分片一个个传上去，全部传完才写清单；清单写上去那一刻换成 segmented。 */
  async function migrate(generationAtStart) {
    if (mode !== 'legacy' || migrating) return;
    migrating = true;
    try {
      reconcile();
      const names = [...segments.values()].filter(segment => !segment.exists).map(segment => segmentFile(segment.id));
      const present = names.length ? await files.exists?.(names) : null;
      leftovers = new Set(names.filter(name => present?.[name]));
      if (generationAtStart !== generation) return;
      for (;;) {
        /* 一小批一小批传，每批之前看一眼：别的设备已经拆完了就改用它的，不再传。 */
        const existing = await readManifest();
        if (generationAtStart !== generation) return;
        if (existing) {
          await adoptServerLayout(existing);
          return;
        }
        reconcile();
        const targets = dirtySegments();
        if (!targets.length) break;
        const batch = targets.slice(0, MIGRATE_POOL);
        const errors = await runPool(batch.map(segment => () => uploadSegment(segment)), MIGRATE_POOL, { stopOnError: true });
        if (generationAtStart !== generation) return;
        if (errors.length) throw errors[0];
      }
      if (legacyInfo) {
        /* 拆分期间旧文件可能又被自己写过，记下它现在的样子，以后才看得出「之后又被改过」。 */
        const head = await files.head(legacyFile);
        if (head?.status === 200 && head.etag) legacyInfo = { ...legacyInfo, etag: head.etag };
      }
      if (generationAtStart !== generation) return;
      await syncManifest({ creating: true });
      if (generationAtStart !== generation) return;
      for (const segment of segments.values()) segment.confirmedAt = now();
      mode = 'segmented';
      lastError = null;
      /* 写清单那一小会儿里又改过的，补上。 */
      await flushSegments();
    } catch (error) {
      migrateFailedAt = now();
      throw error;
    } finally {
      migrating = false;
    }
  }

  return {
    readDocument,

    /* 存储读完、文档建好之后交给这里：之后后台的活（拆分、补写）都从这份活的文档里取记录。 */
    attach(document) {
      live = document;
      runInBackground(async generationAtStart => {
        if (mode === 'legacy') {
          await migrate(generationAtStart);
          return;
        }
        /* 只有接过旧文件里后加的记录时才有东西要写；平常打开页面什么都不写。 */
        reconcile();
        if (dirtySegments().length) await flushSegments();
        else maybeSyncManifest();
      });
    },

    /* 这条记录的内容变了（新加、删除不用报也认得出来，报了也无妨）。 */
    noteChange(id) {
      if (id === undefined || id === null) return;
      changedIds.add(String(id));
      if (mode !== 'segmented') return;
      const segment = segments.get(assignment.get(String(id))) || tail;
      if (segment) refreshForeign(segment);
    },

    async writeDocument(document) {
      if (mode === 'unloaded') throw new Error(`${label}还没读进来`);
      live = document;
      if (mode === 'segmented') {
        await flushSegments();
        return;
      }
      /* 还没拆分完：旧文件说了算，照旧整份写。 */
      await files.write(legacyFile, JSON.stringify(document));
      if (mode === 'legacy' && !migrating && now() - migrateFailedAt >= MIGRATE_RETRY_MS) {
        runInBackground(generationAtStart => migrate(generationAtStart));
      }
    },

    /* 页面要转入后台了（存储的 flush() 会先调这个）：接下来的写入当场发，不等任何别的请求回来。 */
    expedite() {
      urgentUntil = now() + URGENT_WINDOW_MS;
    },

    /* 设置页显示用：现在是拆开的还是整份的、多少个分片、最近一次后台出的错。 */
    status() {
      let count = 0;
      for (const segment of segments.values()) {
        if (segment.exists || segment.ids.size) count += 1;
      }
      return {
        mode,
        segments: count,
        records: live ? Object.keys(live[recordsKey]).length : assignment.size,
        migrating,
        /* DirectError 的 message 是给界面的一句笼统话，具体原因在 details 里。 */
        error: lastError ? String(lastError.details || lastError.message || lastError) : '',
      };
    },

    /* 测试用：等后台的活（拆分、改清单、看别人加的记录）都做完。 */
    async whenIdle() {
      for (;;) {
        const before = [background, manifestChain, ...refreshes];
        await Promise.allSettled(before);
        if (before[0] === background && before[1] === manifestChain && !refreshes.size && !manifestQueued) return;
      }
    },
  };
}
