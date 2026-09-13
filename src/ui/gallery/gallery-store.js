import { bytesToBase64 } from '../api/openai-direct.js';

/* 画廊元数据独立存储 —— 1.6.2
   之前画廊数组放在 extension_settings.stImageAtelier.gallery 里，跟着 settings.json 一起落盘。
   每张图的提示词存了三遍、删除只打标不清理，926 条把 settings.json 撑到 22.9MB，
   酒馆客户端保存失败、全局设置被重置。

   现在：
   - 元数据单独存成酒馆用户文件 user/files/st-image-atelier-gallery.json，
     通过 /api/files/upload 写、GET /user/files/<name> 读（Data Bank 用的就是这套接口）。
   - extension_settings 里只留真正的设置项，画廊一条都不进去。
   - 每条记录只存一份提示词（promptSnapshot），删除就是从数组里移除。 */

export const GALLERY_FILE_NAME = 'st-image-atelier-gallery.json';
export const GALLERY_FILE_VERSION = 1;
export const GALLERY_FILES_UPLOAD_PATH = '/api/files/upload';
export const GALLERY_FILES_BASE_PATH = '/user/files/';

/* 提示词三选一：promptSnapshot 是实际发给上游的基础提示词（含临时覆盖），留它。
   - prompt 是标签原文，需要时从聊天元数据的 tag.prompt 拿；
   - resolvedPrompt 是 NAI 拼好画师串和质量标签之后的串，可由 promptSnapshot +
     artistPromptSnapshot 重新拼出来；
   - resolvedNegativePrompt 同理，由 negativePromptSnapshot + artistNegativePromptSnapshot 拼。
   删除改真删之后 deletedAt 也没有意义了。 */
const REDUNDANT_FIELDS = ['prompt', 'resolvedPrompt', 'resolvedNegativePrompt', 'deletedAt'];

export function slimGalleryResult(value = {}) {
  if (value.status === 'deleted') return tombstoneFields(value, value.deletedAt ?? null);
  const promptSnapshot = String(value.promptSnapshot || value.prompt || value.resolvedPrompt || '');
  const negativePromptSnapshot = String(
    value.negativePromptSnapshot ?? value.resolvedNegativePrompt ?? '',
  );
  const provider = value.provider === 'novelai'
    || value.presetId === 'novelai'
    || value.artistPresetId
    ? 'novelai'
    : 'openai';
  const result = { ...value, promptSnapshot, negativePromptSnapshot, provider, favorite: value.favorite === true };
  for (const field of REDUNDANT_FIELDS) delete result[field];
  return result;
}

export function isSlimGalleryResult(value = {}) {
  return REDUNDANT_FIELDS.every(field => !(field in value))
    && typeof value.promptSnapshot === 'string'
    && typeof value.negativePromptSnapshot === 'string'
    && typeof value.favorite === 'boolean';
}

/* 需要 prompt / resolvedPrompt 时按需派生，不再落盘。 */
export function deriveResultPrompts(result, { tag = null, composeNovelAi = null } = {}) {
  const promptSnapshot = String(result?.promptSnapshot || '');
  const artistPrompt = String(result?.artistPromptSnapshot || '');
  const resolvedPrompt = result?.provider === 'novelai' && composeNovelAi
    ? composeNovelAi(promptSnapshot, artistPrompt)
    : (artistPrompt ? `${artistPrompt}, ${promptSnapshot}` : promptSnapshot);
  return {
    prompt: String(tag?.prompt || promptSnapshot),
    promptSnapshot,
    resolvedPrompt,
  };
}

/* 聊天元数据里的墓碑：只保留识别信息，提示词一律不带。 */
export function tombstoneFields(result, deletedAt) {
  return {
    resultId: result.resultId,
    attemptId: result.attemptId ?? null,
    tagId: result.tagId ?? null,
    generationIndex: result.generationIndex ?? null,
    status: 'deleted',
    deletedAt,
    favorite: false,
  };
}

function encodeJson(value) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

export function createGalleryStore({
  fetchImpl = (...args) => globalThis.fetch(...args),
  headers = () => ({ 'Content-Type': 'application/json' }),
  fileName = GALLERY_FILE_NAME,
  log = console,
} = {}) {
  let items = [];
  let loaded = false;
  let dirty = false;
  let writing = null;
  let lastError = null;

  async function load() {
    const url = `${GALLERY_FILES_BASE_PATH}${fileName}?t=${Date.now()}`;
    const response = await fetchImpl(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 404) {
      items = [];
      loaded = true;
      return { items: [], missing: true };
    }
    if (!response.ok) throw new Error(`画廊索引读取失败：HTTP ${response.status}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('画廊索引文件不是有效 JSON');
    }
    const list = Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload) ? payload : []);
    items = list.filter(item => item && typeof item === 'object' && item.resultId);
    loaded = true;
    return { items, missing: false, version: payload?.version ?? null };
  }

  async function write() {
    const document = {
      version: GALLERY_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      items,
    };
    const response = await fetchImpl(GALLERY_FILES_UPLOAD_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers(),
      body: JSON.stringify({ name: fileName, data: encodeJson(document) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`画廊索引写入失败：HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
  }

  /* 写入串行化：进行中的写完成后若又有改动，再写一次。返回的 promise 在最新状态落盘后才结束。 */
  function persist() {
    dirty = true;
    if (!writing) {
      writing = (async () => {
        try {
          while (dirty) {
            dirty = false;
            await write();
          }
          lastError = null;
        } catch (error) {
          lastError = error;
          log?.error?.('[Image Atelier] 画廊索引落盘失败', error);
          throw error;
        } finally {
          writing = null;
        }
      })();
    }
    return writing;
  }

  return {
    fileName,
    load,
    persist,
    isLoaded: () => loaded,
    lastError: () => lastError,
    items: () => items,
    replace(next) {
      items = Array.isArray(next) ? next : [];
      loaded = true;
    },
    find(resultId) {
      return items.find(item => item.resultId === resultId) || null;
    },
    has(resultId) {
      return items.some(item => item.resultId === resultId);
    },
    add(results) {
      const known = new Set(items.map(item => item.resultId));
      let added = 0;
      for (const result of results) {
        if (!result?.resultId || known.has(result.resultId)) continue;
        items.push(result);
        known.add(result.resultId);
        added += 1;
      }
      return added;
    },
    remove(resultId) {
      const index = items.findIndex(item => item.resultId === resultId);
      if (index < 0) return null;
      const [removed] = items.splice(index, 1);
      return removed;
    },
  };
}
