import {
  DEFAULT_ARTIST_PRESET,
  DEFAULT_NOVELAI_CONFIG,
  DEFAULT_PRESET,
  DEFAULT_SETTINGS,
  MODULE_NAME,
  SCHEMA_VERSION,
  VERSION,
} from '../../shared/constants.js';
import {
  DirectError,
  base64ToBytes,
  buildRequestBody,
  bytesToBase64,
  detectImageType,
  generateImages,
  listModelsDirect,
} from './openai-direct.js';
import { generateNovelAiImages } from './novelai-direct.js';
import {
  createSillyTavernGalleryMetadataStore,
  normalizeGalleryRecord,
} from './gallery-metadata-store.js';
import { createSillyTavernAttemptStore } from './attempt-store.js';
import {
  createArtistPresetExport,
  parseArtistPresetImport,
} from './artist-preset-transfer.js';
import { normalizeRetentionSettings, selectCleanupCandidates } from '../gallery/retention.js';
import { normalizeThemeMode } from '../theme/theme.js';
import { locateTag } from '../state/tag-identity.js';
import {
  MAX_RESULTS_PER_TAG,
  canonicalTag,
  displayableResultIds,
  hasLegacyFields,
  hydrateAttempt,
  leanTag,
  normalizeLatestResultId,
  rebuildInPlace,
  selectResultEvictions,
  slimAttempt,
  tagResultIds,
  writeTagResults,
} from '../state/tag-storage.js';
import { chatTagsFootprint, describeFootprint, warnIfHeavy } from '../state/tag-footprint.js';

const LEGACY_API_KEY_STORAGE = 'stImageAtelier.directApiKey.v1';
const API_KEY_STORAGE_PREFIX = 'stImageAtelier.directApiKey.v2:';
const NOVELAI_KEY_STORAGE = 'stImageAtelier.novelAiApiKey.v1';
const ACTIVE_STATUSES = new Set(['queued', 'generating', 'downloading', 'saving']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);
const NAMESPACE_KEYS = new Set([
  'settings',
  'presets',
  'artistPresets',
  'novelAi',
  'activePresetId',
  'activeArtistPresetId',
  'schemaVersion',
]);

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return globalThis.crypto?.randomUUID?.()
    || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
      const random = Math.floor(Math.random() * 16);
      return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    });
}

/* 1.6.15 起慢的图可以留在后台等：没改过的老默认值（3 分钟）和老上限（10 分钟）换成新的默认
   1 小时，自己设的其他值不动。看原始数据里有没有 timeoutVersion，每个预设只迁一次。 */
const LEGACY_TIMEOUTS = new Set([180_000, 600_000]);

function normalizePreset(value = {}) {
  const migrateTimeout = !(Number(value.timeoutVersion) >= DEFAULT_PRESET.timeoutVersion);
  const preset = {
    ...clone(DEFAULT_PRESET),
    ...value,
    cachedModels: Array.isArray(value.cachedModels) ? value.cachedModels : [],
    extraBody: value.extraBody && typeof value.extraBody === 'object' ? value.extraBody : {},
    ratioMap: {
      ...clone(DEFAULT_PRESET.ratioMap),
      ...(value.ratioMap || {}),
    },
  };
  preset.id = String(preset.id || uuid());
  preset.name = String(preset.name || '未命名预设').trim() || '未命名预设';
  if (migrateTimeout) {
    if (LEGACY_TIMEOUTS.has(Number(preset.timeoutMs))) preset.timeoutMs = DEFAULT_PRESET.timeoutMs;
    preset.timeoutVersion = DEFAULT_PRESET.timeoutVersion;
  }
  return preset;
}

function normalizeNovelAiConfig(value = {}) {
  const config = {
    ...clone(DEFAULT_NOVELAI_CONFIG),
    ...value,
    ratioMap: {
      ...clone(DEFAULT_NOVELAI_CONFIG.ratioMap),
      ...(value.ratioMap || {}),
    },
  };
  const qualityPreset = String(value.v5QualityPreset || '');
  config.v5QualityPreset = ['none', 'light', 'standard'].includes(qualityPreset)
    ? qualityPreset
    : value.qualityTags === false ? 'none' : 'standard';
  const ucPreset = String(value.v5UcPreset || '');
  config.v5UcPreset = ['none', 'light', 'heavy', 'human_focus'].includes(ucPreset)
    ? ucPreset
    : 'none';
  return config;
}

function normalizeArtistPreset(value = {}) {
  const preset = { ...clone(DEFAULT_ARTIST_PRESET), ...value };
  preset.id = String(preset.id || uuid());
  preset.name = String(preset.name || '未命名画师串').trim() || '未命名画师串';
  preset.prompt = String(preset.prompt || '').trim();
  preset.negativePrompt = String(preset.negativePrompt || '').trim();
  return preset;
}

function artistPresetSignature(value) {
  return [value.name, value.prompt, value.negativePrompt]
    .map(part => String(part || '').trim())
    .join('\u0000');
}

function uniqueImportedName(name, presets) {
  const names = new Set(presets.map(item => item.name));
  if (!names.has(name)) return name;
  let suffix = 2;
  while (names.has(`${name}（导入 ${suffix}）`)) suffix += 1;
  return `${name}（导入 ${suffix}）`;
}

function normalizeSettings(value = {}) {
  const merged = { ...clone(DEFAULT_SETTINGS), ...value };
  return {
    ...merged,
    generationProvider: merged.generationProvider === 'novelai' ? 'novelai' : 'openai',
    backupPresetId: String(merged.backupPresetId || ''),
    enableAutoFallback: merged.enableAutoFallback === true,
    executionMode: merged.executionMode === 'server' ? 'server' : 'direct',
    themeMode: normalizeThemeMode(merged.themeMode),
    ...normalizeRetentionSettings(merged),
  };
}

export function normalizeGalleryResult(value = {}) {
  return normalizeGalleryRecord(value);
}

function ensureNamespace(extensionSettings) {
  const previous = extensionSettings[MODULE_NAME];
  const namespace = previous && typeof previous === 'object' ? previous : {};
  const legacyGallery = Array.isArray(namespace.gallery) ? clone(namespace.gallery) : [];
  namespace.settings = normalizeSettings(namespace.settings);
  const sourcePresets = Array.isArray(namespace.presets) && namespace.presets.length
    ? namespace.presets
    : [namespace.preset || DEFAULT_PRESET];
  const seenIds = new Set();
  namespace.presets = sourcePresets.map(value => {
    const preset = normalizePreset(value);
    if (seenIds.has(preset.id)) preset.id = uuid();
    seenIds.add(preset.id);
    return preset;
  });
  namespace.activePresetId = namespace.presets.some(item => item.id === namespace.activePresetId)
    ? namespace.activePresetId
    : namespace.presets[0].id;
  delete namespace.preset;
  namespace.novelAi = normalizeNovelAiConfig(namespace.novelAi);
  const sourceArtistPresets = Array.isArray(namespace.artistPresets) && namespace.artistPresets.length
    ? namespace.artistPresets
    : [DEFAULT_ARTIST_PRESET];
  const artistIds = new Set();
  namespace.artistPresets = sourceArtistPresets.map(value => {
    const preset = normalizeArtistPreset(value);
    if (artistIds.has(preset.id)) preset.id = uuid();
    artistIds.add(preset.id);
    return preset;
  });
  namespace.activeArtistPresetId = namespace.artistPresets
    .some(item => item.id === namespace.activeArtistPresetId)
    ? namespace.activeArtistPresetId
    : namespace.artistPresets[0].id;
  extensionSettings[MODULE_NAME] = namespace;
  return { namespace, legacyGallery };
}

function maskKey(value) {
  if (!value) return '';
  if (value.length < 8) return '••••••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

function normalizePath(value) {
  const path = String(value || '');
  if (!path || /^(?:https?:|data:|blob:)/i.test(path) || path.startsWith('/')) return path;
  return `/${path.replace(/^\/+/, '')}`;
}

function publicPreset(preset, apiKey) {
  return {
    ...clone(preset),
    hasApiKey: Boolean(apiKey),
    apiKeyMask: maskKey(apiKey),
  };
}

function createdAtOf(record) {
  return String(record?.createdAt || '');
}

export function createDirectApiClient({
  compat,
  extensionSettings,
  saveSettingsDebounced,
  keyStorage = globalThis.localStorage,
  galleryStore,
  attemptStore: attemptStoreOption,
  verifyFile,
}) {
  const { namespace, legacyGallery } = ensureNamespace(extensionSettings);
  const metadataStore = galleryStore || createSillyTavernGalleryMetadataStore(compat);
  const attemptStore = attemptStoreOption || createSillyTavernAttemptStore(compat);
  const controllers = new Map();
  /* 画廊记录的内存索引：按 resultId 直接取，按 tagId 找属于这张卡的图。 */
  const resultIndex = new Map();
  const resultsByTag = new Map();
  const memoryKeys = new Map();
  const legacyMigrations = new Map();
  let cleanupPromise = null;
  let readyPromise = null;

  function rememberResult(record) {
    const previous = resultIndex.get(record.resultId);
    if (previous && previous.tagId !== record.tagId) resultsByTag.get(previous.tagId)?.delete(record.resultId);
    resultIndex.set(record.resultId, record);
    if (!resultsByTag.has(record.tagId)) resultsByTag.set(record.tagId, new Set());
    resultsByTag.get(record.tagId).add(record.resultId);
  }

  function forgetResult(resultId) {
    const record = resultIndex.get(resultId);
    if (!record) return;
    resultIndex.delete(resultId);
    const owned = resultsByTag.get(record.tagId);
    owned?.delete(resultId);
    if (owned && !owned.size) resultsByTag.delete(record.tagId);
  }

  function resetResults() {
    resultIndex.clear();
    resultsByTag.clear();
  }

  function lookup(resultId) {
    return resultIndex.get(resultId) || null;
  }

  /* 画廊里属于这个标签的图，按出图先后。 */
  function ownedResults(tagId) {
    return [...(resultsByTag.get(tagId) || [])]
      .map(resultId => resultIndex.get(resultId))
      .filter(Boolean)
      .sort((left, right) => createdAtOf(left).localeCompare(createdAtOf(right)));
  }

  function presetById(presetId = namespace.activePresetId) {
    return namespace.presets.find(item => item.id === presetId) || null;
  }

  function activePreset() {
    return presetById() || namespace.presets[0];
  }

  function artistPresetById(presetId = namespace.activeArtistPresetId) {
    return namespace.artistPresets.find(item => item.id === presetId) || null;
  }

  function activeArtistPreset() {
    return artistPresetById() || namespace.artistPresets[0];
  }

  function keyStorageName(presetId) {
    return `${API_KEY_STORAGE_PREFIX}${presetId}`;
  }

  function getApiKey(presetId = namespace.activePresetId) {
    const storageName = keyStorageName(presetId);
    try {
      const current = keyStorage?.getItem(storageName);
      if (current) return current;
      if (presetId === 'default') {
        const legacy = keyStorage?.getItem(LEGACY_API_KEY_STORAGE);
        if (legacy) {
          keyStorage?.setItem(storageName, legacy);
          return legacy;
        }
      }
      return memoryKeys.get(presetId) || '';
    } catch {
      return memoryKeys.get(presetId) || '';
    }
  }

  function setApiKey(presetId, value) {
    memoryKeys.set(presetId, value);
    const storageName = keyStorageName(presetId);
    try {
      if (value) keyStorage?.setItem(storageName, value);
      else keyStorage?.removeItem(storageName);
      if (presetId === 'default') keyStorage?.removeItem(LEGACY_API_KEY_STORAGE);
    } catch {
      // Sandboxed or privacy-restricted browsers can still use the key in this session.
    }
  }

  function getNovelAiKey() {
    try {
      return keyStorage?.getItem(NOVELAI_KEY_STORAGE) || memoryKeys.get(NOVELAI_KEY_STORAGE) || '';
    } catch {
      return memoryKeys.get(NOVELAI_KEY_STORAGE) || '';
    }
  }

  function setNovelAiKey(value) {
    const token = String(value || '').trim().replace(/^Bearer\s+/i, '');
    memoryKeys.set(NOVELAI_KEY_STORAGE, token);
    try {
      if (token) keyStorage?.setItem(NOVELAI_KEY_STORAGE, token);
      else keyStorage?.removeItem(NOVELAI_KEY_STORAGE);
    } catch {
      // Keep the token for this page session when storage is unavailable.
    }
  }

  function publicNovelAiConfig() {
    const apiKey = getNovelAiKey();
    return {
      ...clone(namespace.novelAi),
      hasApiKey: Boolean(apiKey),
      apiKeyMask: maskKey(apiKey),
    };
  }

  /* 画廊元数据和生成记录都在当前 ST 用户文件里，第一次用之前读进来。 */
  async function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      await metadataStore.initialize({
        legacyItems: legacyGallery,
      });
      await attemptStore.initialize();
      resetResults();
      for (const result of metadataStore.values()) rememberResult(result);
      for (const key of Object.keys(namespace)) {
        if (!NAMESPACE_KEYS.has(key)) delete namespace[key];
      }
      namespace.schemaVersion = SCHEMA_VERSION;
      await Promise.resolve(saveSettingsDebounced?.());
      return metadataStore;
    })();
    try {
      return await readyPromise;
    } catch (error) {
      readyPromise = null;
      throw error;
    }
  }

  async function savePreferences() {
    await ensureReady();
    await Promise.resolve(saveSettingsDebounced?.());
  }

  /* 保存聊天之前检查一遍：这几楼的标签数据超过 20 KB 就在控制台警告并列出各字段大小（防复发）。 */
  async function saveChat(messages = []) {
    const chat = compat.chat();
    for (const message of new Set(messages)) {
      const messageId = chat.indexOf(message);
      if (messageId >= 0) warnIfHeavy(message, messageId);
    }
    await compat.save();
  }

  function findTag(tagId) {
    for (const message of compat.chat()) {
      const metadata = message?.extra?.stImageAtelier;
      const tag = metadata?.tags?.find(item => item.tagId === tagId);
      if (tag) return { message, metadata, tag };
    }
    return null;
  }

  /* 出图后写图片引用时找标签：卡片还在就写当前这一版；画到一半被滑走就写回那一版的存档，
     滑回去就能看到；消息已经不在了（重新生成、删除、改动或切走了聊天）就写进原来那份
     对象，图照常存进画廊，回到原来的聊天时由 resolveTags 按画廊接回卡片。 */
  function locateForWrite(tagId, fallback) {
    return locateTag(compat.chat(), tagId, { isStreaming: compat.isStreaming }) || fallback || null;
  }

  /* 按 attemptId 在画廊里找这次生成存下的图，按出图顺序排。 */
  function resultsOfAttempt(attemptId) {
    return [...resultIndex.values()]
      .filter(result => result.attemptId === attemptId)
      .sort((left, right) => (Number(left.generationIndex) || 0) - (Number(right.generationIndex) || 0));
  }

  function stateOf(tagId) {
    const found = findTag(tagId);
    if (!found) return { tagId, tag: null, attempts: [], results: [] };
    const { tag } = found;
    const available = displayableResultIds(tag, lookup);
    const attempts = attemptStore.forTag(tagId).map(item => hydrateAttempt(item, tag.prompt));
    const autoAttempted = Boolean(tag.autoAttempted
      || attempts.some(attempt => attempt.attemptId === `auto:${tagId}`));
    if (autoAttempted && tag.autoAttempted !== true) tag.autoAttempted = true;
    /* 旧版留在聊天里的 attempts / results 不往卡片送，卡片要的在独立存储和画廊里。 */
    const { attempts: _legacyAttempts, results: _legacyResults, ...rest } = tag;
    return {
      tagId,
      tag: clone({
        ...rest,
        resultIds: available,
        latestResultId: normalizeLatestResultId(tag, lookup),
        autoAttempted,
      }),
      attempts,
      results: clone(available.map(resultId => resultIndex.get(resultId))),
    };
  }

  /* 旧版把生成记录整份复制在聊天里。读状态时先把它们搬进独立存储（精简后），真正写进文件之后
     再从聊天里删掉；搬运中途再读到同一个标签不重复搬，也不提前删。删掉后不单独保存聊天，
     酒馆下次保存时自然带上（「瘦身当前聊天」会立刻保存）。 */
  function migrateLegacyAttempts(tagId) {
    if (legacyMigrations.has(tagId)) return legacyMigrations.get(tagId);
    const found = findTag(tagId);
    const legacy = Array.isArray(found?.tag?.attempts) ? found.tag.attempts : [];
    const fresh = legacy
      .filter(item => item?.attemptId && !attemptStore.has(item.attemptId))
      .map(item => slimAttempt({ ...item, tagId }, found.tag.prompt));
    const pending = (fresh.length ? attemptStore.putMany(fresh) : Promise.resolve())
      .then(() => {
        const current = findTag(tagId)?.tag;
        if (current && Array.isArray(current.attempts)) {
          delete current.attempts;
          rebuildInPlace(current, canonicalTag(current));
        }
      })
      .catch(error => console.warn('[画笺] 搬运旧版生成记录失败，下次再试', error))
      .finally(() => legacyMigrations.delete(tagId));
    legacyMigrations.set(tagId, pending);
    return pending;
  }

  async function requestSt(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: compat.headers(),
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new DirectError('LOCAL_SAVE_FAILED', payload?.error || `HTTP ${response.status}`, response.status);
    }
    return payload;
  }

  async function bytesFromSource(source, signal) {
    if (source.sourceType === 'base64') {
      try {
        return base64ToBytes(source.value);
      } catch (error) {
        throw new DirectError('UPSTREAM_RESPONSE_INVALID', error?.message || 'Base64 解码失败');
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), namespace.settings.downloadTimeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(source.value, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new DirectError('IMAGE_DOWNLOAD_FAILED', `HTTP ${response.status}`, response.status, true);
      }
      const length = Number(response.headers.get('content-length') || 0);
      if (length > namespace.settings.maxImageBytes) {
        throw new DirectError('IMAGE_DOWNLOAD_FAILED', '图片超过 30 MB');
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof DirectError) throw error;
      if (signal?.aborted) throw error;
      throw new DirectError(
        'DIRECT_FETCH_BLOCKED',
        `无法下载图片，可能被浏览器 CORS 阻止：${error?.message || 'Failed to fetch'}`,
        0,
        true,
        '生图成功了，但浏览器下载不了上游返回的图片（图床没开 CORS 或有跳转）；'
          + '请在“高级设置”把「图片返回格式」设为 b64_json 内嵌返回',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function saveSource(source, input, attempt, signal) {
    const bytes = await bytesFromSource(source, signal);
    if (bytes.byteLength > namespace.settings.maxImageBytes) {
      throw new DirectError('IMAGE_DOWNLOAD_FAILED', '图片超过 30 MB');
    }
    const type = detectImageType(bytes);
    if (!type) throw new DirectError('UPSTREAM_RESPONSE_INVALID', '仅支持 PNG、JPEG、WebP');
    const resultId = uuid();
    const uploaded = await requestSt('/api/images/upload', {
      image: bytesToBase64(bytes),
      format: type.extension,
      ch_name: 'st-image-atelier',
      filename: resultId,
    });
    /* 画廊记录是这张图的唯一一份完整元数据：卡片下方的预设、画质、尺寸、用时都从这里拿，
       生成记录被清掉以后照样能显示。 */
    return {
      resultId,
      attemptId: attempt.attemptId,
      tagId: input.tagId,
      generationIndex: source.generationIndex,
      chatId: input.chatId,
      messageUuid: input.messageUuid,
      prompt: input.prompt,
      negativePrompt: attempt.negativePromptSnapshot || '',
      provider: attempt.provider || 'openai',
      presetId: attempt.presetId,
      presetNameSnapshot: attempt.presetNameSnapshot,
      artistPresetId: attempt.artistPresetId || null,
      artistPresetNameSnapshot: attempt.artistPresetNameSnapshot || null,
      artistPromptSnapshot: attempt.artistPromptSnapshot || '',
      artistNegativePromptSnapshot: attempt.artistNegativePromptSnapshot || '',
      generationSeed: attempt.generationSeed ?? null,
      apiModel: attempt.model,
      qualitySnapshot: typeof attempt.qualitySnapshot === 'string' ? attempt.qualitySnapshot : null,
      requestedSize: String(attempt.parameters?.size || ''),
      startedAt: attempt.createdAt,
      localRelativePath: uploaded.path,
      mimeType: type.mimeType,
      byteSize: bytes.byteLength,
      sourceType: source.sourceType,
      status: 'available',
      storageMode: 'direct',
      createdAt: now(),
      favorite: false,
      compatibilityRetry: attempt.compatibilityRetry || null,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  async function removeFile(result) {
    if (!result?.localRelativePath) return;
    try {
      await requestSt('/api/images/delete', { path: result.localRelativePath });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  /* 硬删除：文件、画廊记录、内存索引一起去掉。返回真的删掉的 resultId。 */
  async function evictResults(refs) {
    const removed = [];
    for (const ref of refs) {
      const record = resultIndex.get(ref.resultId);
      if (record) {
        try {
          await removeFile(record);
        } catch (error) {
          console.warn('[画笺] 删除超出上限的旧图失败', ref.resultId, error);
          continue;
        }
      }
      removed.push(ref.resultId);
    }
    const recorded = removed.filter(resultId => resultIndex.has(resultId));
    if (recorded.length) {
      await metadataStore.removeMany(recorded)
        .catch(error => console.warn('[画笺] 删除超出上限的旧图记录失败', error));
    }
    for (const resultId of removed) forgetResult(resultId);
    return removed;
  }

  /* 每张卡最多留 MAX_RESULTS_PER_TAG 张：超了就删最早的（收藏的不删，刚画好的不删）。 */
  async function enforceResultCap(tag, protect = new Set()) {
    const victims = selectResultEvictions(tag.resultRefs || [], lookup, { protect });
    if (!victims.length) return [];
    const removed = await evictResults(victims);
    if (!removed.length) return [];
    const dropped = new Set(removed);
    writeTagResults(tag, tagResultIds(tag).filter(resultId => !dropped.has(resultId)), lookup);
    if (dropped.has(tag.latestResultId) || !tag.latestResultId) {
      tag.latestResultId = normalizeLatestResultId(tag, lookup);
    }
    console.info(
      `[画笺] 这张卡的历史超过 ${MAX_RESULTS_PER_TAG} 张，已删除最早的 ${removed.length} 张（收藏的不删）`,
      tag.tagId,
    );
    return removed;
  }

  async function resolveTags(tagIds) {
    await ensureReady();
    let changed = false;
    const touched = new Set();
    for (const tagId of tagIds) {
      const found = findTag(tagId);
      if (!found) continue;
      const { tag } = found;
      touched.add(found.message);
      if (Array.isArray(tag.attempts)) void migrateLegacyAttempts(tagId);
      for (const attempt of attemptStore.forTag(tagId)) {
        if (!ACTIVE_STATUSES.has(attempt.status) || controllers.has(attempt.attemptId)) continue;
        /* 记录停在「生成中」、这个页面上又没有在跑：多半是画到一半被滑走、切走聊天或刷新了
           页面。图已经存进画廊的，接回卡片上；画廊里没有才算中断。 */
        const recovered = resultsOfAttempt(attempt.attemptId);
        if (recovered.length) {
          attempt.status = 'succeeded';
          attempt.statusMessage = null;
          attempt.resultIds = recovered.map(result => result.resultId);
          attempt.completedAt = recovered.at(-1).createdAt || now();
        } else {
          attempt.status = 'interrupted';
          attempt.errorCode = 'ATTEMPT_INTERRUPTED';
          attempt.errorMessage = '生成被中断，请手动重试';
          attempt.completedAt = now();
        }
        attemptStore.put(attempt).catch(error => console.warn('[画笺] 保存生成记录失败', error));
      }
      if (Object.hasOwn(tag, 'results')) {
        /* 旧版把整份记录复制在聊天里。删之前先把"聊天里可用、索引里没有"的补回索引，
           否则这张图就从卡片上消失了（文件其实还在）。 */
        const orphans = (Array.isArray(tag.results) ? tag.results : [])
          .filter(result => result?.resultId
            && result.status === 'available'
            && result.localRelativePath
            && !resultIndex.has(result.resultId));
        if (orphans.length) {
          const restored = await metadataStore.putMany(orphans.map(result => ({ ...result, tagId })));
          for (const result of restored) rememberResult(result);
        }
        delete tag.results;
        changed = true;
      }
      /* 旧版只记 id：没有画廊记录的去掉（和以前一样）。精简形的引用带着路径，画廊记录不在也留着
         （卡片上不显示），瘦身时按路径核对。 */
      if (Array.isArray(tag.resultIds)) {
        const kept = [...new Set(tag.resultIds)].filter(resultId => resultIndex.has(resultId));
        if (JSON.stringify(kept) !== JSON.stringify(tag.resultIds)) {
          tag.resultIds = kept;
          changed = true;
        }
      }
      /* 画廊里属于这张卡的图，引用里都要有：画到一半切走聊天、再回来时聊天文件里还没记上。 */
      const ids = tagResultIds(tag);
      const known = new Set(ids);
      const missing = ownedResults(tagId)
        .filter(result => !known.has(result.resultId))
        .map(result => result.resultId);
      if (missing.length) {
        writeTagResults(tag, [...ids, ...missing], lookup);
        changed = true;
      }
      /* 只在真的变了时才算改动：还没出图的卡片 latestResultId 本来就是 null，
         不能每读一次就整份聊天保存一次。 */
      const latestResultId = normalizeLatestResultId(tag, lookup);
      if (latestResultId !== tag.latestResultId) {
        tag.latestResultId = latestResultId;
        changed = true;
      }
    }
    if (changed) await saveChat([...touched]);
    /* 等保存完再取状态：手机上酒馆保存聊天要排队，可能等好几秒，这期间图可能已经画好、
       卡片也刷新过了。先取的快照这时候送回去，会把卡片打回「正在保存到酒馆」并一直转圈。 */
    return tagIds.map(stateOf);
  }

  async function generate(input) {
    await ensureReady();
    /* 只给眼前这一版的卡片出图。排着队的旧标签（这一层已经重新生成、正在生成新的滑动版本、
       改动或删除过）在扣费前就停下。 */
    let found = locateTag(compat.chat(), input.tagId, { isStreaming: compat.isStreaming });
    if (found?.placement !== 'active') throw new DirectError('TAG_NOT_FOUND', '找不到对应的生图标签', 404);
    const tagPrompt = found.tag.prompt;
    const existing = attemptStore.get(input.attemptId);
    if (existing) return clone(hydrateAttempt(existing, tagPrompt));
    const provider = input.provider || namespace.settings.generationProvider || 'openai';
    const preset = provider === 'novelai'
      ? null
      : clone(presetById(input.presetId) || activePreset());
    if (provider !== 'novelai' && !preset) {
      throw new DirectError('PRESET_NOT_CONFIGURED', '找不到所选 API 预设');
    }
    const novelAi = provider === 'novelai' ? clone(namespace.novelAi) : null;
    const artistPreset = provider === 'novelai'
      ? clone(artistPresetById(input.artistPresetId) || activeArtistPreset())
      : null;
    if (provider === 'novelai' && !artistPreset) {
      throw new DirectError('PRESET_NOT_CONFIGURED', '找不到所选画师串预设');
    }
    const apiKey = provider === 'novelai' ? getNovelAiKey() : getApiKey(preset.id);
    const requestedSize = provider === 'novelai'
      ? (novelAi.ratioMap?.[input.parameters?.ratio] || novelAi.defaultSize)
      : (preset.ratioMap?.[input.parameters?.ratio] || preset.defaultSize);

    const attempt = {
      attemptId: input.attemptId,
      tagId: input.tagId,
      requestMode: input.requestMode,
      provider,
      presetId: provider === 'novelai' ? 'novelai' : preset.id,
      presetNameSnapshot: provider === 'novelai' ? 'NovelAI' : preset.name,
      artistPresetId: artistPreset?.id || null,
      artistPresetNameSnapshot: artistPreset?.name || null,
      model: provider === 'novelai' ? novelAi.model : preset.selectedModel,
      promptSnapshot: input.prompt,
      negativePromptSnapshot: provider === 'novelai'
        ? (Object.hasOwn(input, 'negativePromptOverride')
          ? String(input.negativePromptOverride || '')
          : String(novelAi.negativePrompt || ''))
        : '',
      artistPromptSnapshot: artistPreset?.prompt || '',
      artistNegativePromptSnapshot: artistPreset?.negativePrompt || '',
      parameters: { ...clone(input.parameters || {}), size: requestedSize },
      status: 'generating',
      /* 自动换备用线路时卡片上那句「主线路……已换备用线路……」，画完就清掉。 */
      statusMessage: input.statusMessage ? String(input.statusMessage).slice(0, 200) : null,
      resultIds: [],
      errorCode: null,
      errorMessage: null,
      createdAt: now(),
      completedAt: null,
      schemaVersion: SCHEMA_VERSION,
    };
    /* 记下这次实际发出去的画质：预设默认值、标签里写的、「不发送」、额外请求参数 JSON 都算进去，
       和真正的请求体同一套规则。卡片下方显示用；没发 quality 时是空字符串。 */
    if (provider !== 'novelai') {
      attempt.qualitySnapshot = String(buildRequestBody({
        preset,
        prompt: input.prompt,
        parameters: attempt.parameters,
      }).quality || '');
    }
    /* 生成记录只进独立存储，聊天里不留；精简后再存（画师串整段、拼好的提示词不存）。
       persist=false 只改内存：进度更新不必每步落盘。 */
    const persist = options => attemptStore.put(slimAttempt(attempt, tagPrompt), options);

    const controller = new AbortController();
    controllers.set(attempt.attemptId, controller);
    try {
      /* 发上游请求前先把记录写进独立文件（防重复）。自动生图再在聊天里记一笔 autoAttempted：
         独立存储的记录满了被清掉，也不会再自动画一次。 */
      await persist();
      if (input.requestMode === 'auto' && found.tag.autoAttempted !== true) {
        found.tag.autoAttempted = true;
        await saveChat([found.message]);
      }
    } catch (error) {
      controllers.delete(attempt.attemptId);
      throw new DirectError('LOCAL_SAVE_FAILED', `无法在扣费前保存防重复记录：${error.message}`);
    }

    const saved = [];
    try {
      let sources;
      if (provider === 'novelai') {
        const generated = await generateNovelAiImages({
          config: { ...novelAi, negativePrompt: attempt.negativePromptSnapshot },
          apiKey,
          artistPrompt: artistPreset.prompt,
          artistNegativePrompt: artistPreset.negativePrompt,
          prompt: input.prompt,
          parameters: attempt.parameters,
          settings: namespace.settings,
          signal: controller.signal,
        });
        sources = generated.sources;
        attempt.resolvedPrompt = generated.resolvedPrompt;
        attempt.resolvedNegativePrompt = generated.resolvedNegativePrompt;
        attempt.generationSeed = generated.seed;
      } else {
        sources = await generateImages({
          preset,
          apiKey,
          prompt: input.prompt,
          parameters: attempt.parameters,
          settings: namespace.settings,
          signal: controller.signal,
          onCompatibilityRetry: async retry => {
            attempt.compatibilityRetry = retry;
            attempt.statusMessage = retry.message;
            await persist({ persist: false });
            input.onProgress?.(clone(attempt));
          },
        });
      }

      attempt.status = 'downloading';
      attempt.statusMessage = null;
      await persist({ persist: false });
      for (const source of sources) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('cancelled');
        saved.push(await saveSource(source, input, attempt, controller.signal));
      }

      attempt.status = 'saving';
      await persist({ persist: false });
      const normalizedSaved = await metadataStore.putMany(saved);
      saved.splice(0, saved.length, ...normalizedSaved);
      for (const result of saved) rememberResult(result);
      found = locateForWrite(input.tagId, found);
      /* 后台那张（之后又 roll 过）画好时，新的那次已经出图，就不抢卡片上显示的那张，只进历史。 */
      const siblings = attemptStore.forTag(input.tagId);
      const position = siblings.findIndex(item => item.attemptId === attempt.attemptId);
      const newerSucceeded = siblings.slice(0, Math.max(0, position)).some(item => item.status === 'succeeded');
      writeTagResults(found.tag, [...tagResultIds(found.tag), ...saved.map(result => result.resultId)], lookup);
      if (!newerSucceeded || !found.tag.latestResultId) {
        found.tag.latestResultId = saved.at(-1)?.resultId || found.tag.latestResultId || null;
      }
      await enforceResultCap(found.tag, new Set(saved.map(result => result.resultId)));
      attempt.status = 'succeeded';
      attempt.resultIds = saved.map(result => result.resultId);
      attempt.completedAt = now();
      /* 先改内存再保存聊天：保存触发的重绘读到的是「已完成」。聊天只在出图后保存这一次。 */
      await persist({ persist: false });
      await saveChat([found.message]);
      await persist().catch(error => console.warn('[画笺] 保存生成记录失败（图片已经存好）', error));
      return clone(attempt);
    } catch (error) {
      await Promise.allSettled(saved.map(removeFile));
      await metadataStore.removeMany(saved.map(result => result.resultId)).catch(() => {});
      for (const result of saved) forgetResult(result.resultId);
      if (found?.tag) {
        const discarded = new Set(saved.map(result => result.resultId));
        const ids = tagResultIds(found.tag);
        if (ids.some(resultId => discarded.has(resultId))) {
          writeTagResults(found.tag, ids.filter(resultId => !discarded.has(resultId)), lookup);
          if (discarded.has(found.tag.latestResultId)) {
            found.tag.latestResultId = normalizeLatestResultId(found.tag, lookup);
          }
        }
      }
      const cancelled = controller.signal.aborted;
      attempt.status = cancelled ? 'cancelled' : 'failed';
      attempt.errorCode = cancelled ? null : (error.code || 'UPSTREAM_HTTP_ERROR');
      attempt.errorMessage = cancelled ? '已取消' : (error.message || '生成失败');
      if (!cancelled && attempt.compatibilityRetry) {
        attempt.errorMessage += `；已尝试移除 ${attempt.compatibilityRetry.adjustedParameters.join('、')} 后重试一次`;
      }
      attempt.completedAt = now();
      await persist().catch(() => {});
      if (cancelled) return clone(attempt);
      throw error;
    } finally {
      controllers.delete(attempt.attemptId);
    }
  }

  async function cancel(attemptId) {
    controllers.get(attemptId)?.abort(new Error('cancelled'));
    await ensureReady();
    const attempt = attemptStore.get(attemptId);
    if (!attempt || TERMINAL_STATUSES.has(attempt.status)) return null;
    attempt.status = 'cancelled';
    attempt.errorMessage = '已取消';
    attempt.completedAt = now();
    await attemptStore.put(attempt);
    return clone(hydrateAttempt(attempt, findTag(attempt.tagId)?.tag?.prompt));
  }

  async function gallery({ cursor, limit = 30 } = {}) {
    await ensureReady();
    const start = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
    const items = metadataStore.values()
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const page = items.slice(start, start + limit);
    page.forEach(result => rememberResult(result));
    return {
      items: clone(page),
      nextCursor: start + limit < items.length ? String(start + limit) : null,
    };
  }

  async function galleryMetadata() {
    await ensureReady();
    const items = metadataStore.values()
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    items.forEach(result => {
      Object.assign(result, normalizeGalleryResult(result));
      rememberResult(result);
    });
    return { items: clone(items), total: items.length };
  }

  async function setFavorite(resultId, favorite) {
    await ensureReady();
    const result = resultIndex.get(resultId);
    if (!result || result.status !== 'available') {
      throw new DirectError('VALIDATION_FAILED', '找不到图片');
    }
    const updated = await metadataStore.update(resultId, { favorite: favorite === true });
    rememberResult(updated);
    return clone(updated);
  }

  async function deleteResult(resultId) {
    await ensureReady();
    const result = resultIndex.get(resultId);
    if (!result) throw new DirectError('VALIDATION_FAILED', '找不到图片');
    await removeFile(result);
    await metadataStore.remove(resultId);
    forgetResult(resultId);
    const found = findTag(result.tagId);
    if (found) {
      writeTagResults(found.tag, tagResultIds(found.tag).filter(id => id !== resultId), lookup);
      found.tag.latestResultId = normalizeLatestResultId(found.tag, lookup);
      found.tag.autoSuppressed = true;
      await saveChat([found.message]);
    }
    return { resultId, status: 'deleted' };
  }

  async function performGalleryCleanup() {
    await ensureReady();
    const selection = selectCleanupCandidates(metadataStore.values(), namespace.settings);
    if (!selection.settings.galleryCleanupByAge && !selection.settings.galleryCleanupByCount) {
      return {
        enabled: false,
        candidateCount: 0,
        deletedCount: 0,
        failedCount: 0,
        keptCount: selection.availableCount,
        byAgeCount: 0,
        byCountCount: 0,
        deletedIds: [],
      };
    }

    const deletedIds = [];
    const affectedTags = new Set();
    for (const result of selection.candidates) {
      try {
        await removeFile(result);
      } catch (error) {
        console.warn('[画笺] 自动清理图片失败', result.resultId, error);
        continue;
      }
      deletedIds.push(result.resultId);
      affectedTags.add(result.tagId);
    }

    await metadataStore.removeMany(deletedIds);
    for (const resultId of deletedIds) forgetResult(resultId);

    const touched = new Set();
    const deleted = new Set(deletedIds);
    for (const tagId of affectedTags) {
      const found = findTag(tagId);
      if (!found) continue;
      writeTagResults(found.tag, tagResultIds(found.tag).filter(resultId => !deleted.has(resultId)), lookup);
      found.tag.latestResultId = normalizeLatestResultId(found.tag, lookup);
      found.tag.autoSuppressed = true;
      touched.add(found.message);
    }
    if (touched.size) await saveChat([...touched]);

    return {
      enabled: true,
      candidateCount: selection.candidates.length,
      deletedCount: deletedIds.length,
      failedCount: selection.candidates.length - deletedIds.length,
      keptCount: selection.availableCount - deletedIds.length,
      byAgeCount: selection.byAgeCount,
      byCountCount: selection.byCountCount,
      deletedIds,
    };
  }

  function cleanupGallery() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = performGalleryCleanup().finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  }

  function fileUrl(resultId) {
    const result = resultIndex.get(resultId);
    return normalizePath(result?.localRelativePath);
  }

  /* 瘦身时核对画廊里没有记录的引用：文件还在就把记录补回画廊，不在就把引用去掉。 */
  async function fileExists(path) {
    if (typeof verifyFile === 'function') return Boolean(await verifyFile(path));
    const url = normalizePath(path);
    if (!url) return false;
    let response = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    }
    return response.ok;
  }

  /* 「瘦身当前聊天」：遍历所有楼层（含滑动存档 swipe_info[].extra 里的副本），把旧版留在聊天里的
     生成记录搬进独立存储、整份图片记录补回画廊，标签改写成精简形（只留图片引用），超过每张卡
     上限的旧图硬删，最后只保存一次聊天。重复执行没有副作用。dryRun 只算账、不动任何数据。 */
  async function slimChat({ dryRun = false } = {}) {
    await ensureReady();
    const chat = compat.chat();
    const before = chatTagsFootprint(chat);
    const containers = [];
    for (const [messageId, message] of chat.entries()) {
      const active = message?.extra?.stImageAtelier;
      if (Array.isArray(active?.tags)) containers.push({ message, messageId, metadata: active, placement: 'active' });
      const swipes = Array.isArray(message?.swipe_info) ? message.swipe_info : [];
      for (const [swipeId, swipe] of swipes.entries()) {
        const metadata = swipe?.extra?.stImageAtelier;
        if (Array.isArray(metadata?.tags)) containers.push({ message, messageId, metadata, placement: 'swipe', swipeId });
      }
    }

    const attemptsToMove = new Map();
    const orphans = new Map();
    const dangling = new Map();
    let tagCount = 0;
    let legacyTagCount = 0;
    for (const container of containers) {
      for (const tag of container.metadata.tags) {
        if (!tag?.tagId) continue;
        tagCount += 1;
        if (hasLegacyFields(tag)) legacyTagCount += 1;
        for (const item of Array.isArray(tag.attempts) ? tag.attempts : []) {
          if (!item?.attemptId || attemptStore.has(item.attemptId) || attemptsToMove.has(item.attemptId)) continue;
          attemptsToMove.set(item.attemptId, slimAttempt({ ...item, tagId: tag.tagId }, tag.prompt));
        }
        for (const record of Array.isArray(tag.results) ? tag.results : []) {
          if (!record?.resultId || record.status !== 'available' || !record.localRelativePath) continue;
          if (resultIndex.has(record.resultId) || orphans.has(record.resultId)) continue;
          orphans.set(record.resultId, { ...record, tagId: tag.tagId });
        }
        for (const ref of Array.isArray(tag.resultRefs) ? tag.resultRefs : []) {
          if (!ref?.resultId || !ref.path || resultIndex.has(ref.resultId)) continue;
          if (orphans.has(ref.resultId) || dangling.has(ref.resultId)) continue;
          dangling.set(ref.resultId, { ...ref, tagId: tag.tagId, prompt: tag.prompt });
        }
      }
    }

    if (dryRun) {
      const seen = new Set();
      let wouldDelete = 0;
      for (const container of containers) {
        for (const tag of container.metadata.tags) {
          if (!tag?.tagId || seen.has(tag.tagId)) continue;
          seen.add(tag.tagId);
          const lean = leanTag(tag, resultId => lookup(resultId) || orphans.get(resultId) || null);
          wouldDelete += selectResultEvictions(lean.resultRefs, lookup).length;
        }
      }
      return {
        dryRun: true,
        before,
        after: before,
        messages: chat.length,
        tags: tagCount,
        legacyTags: legacyTagCount,
        movedAttempts: attemptsToMove.size,
        restoredResults: orphans.size,
        danglingRefs: dangling.size,
        deletedImages: wouldDelete,
        droppedRefs: 0,
        changed: false,
      };
    }

    console.info(`[画笺] 瘦身前：生图标签数据共 ${before.bytes} 字节，${describeFootprint(before)}`);
    /* 先把要留的搬走、写进文件，再动聊天：中途失败也不会丢数据。 */
    if (orphans.size) {
      const restored = await metadataStore.putMany([...orphans.values()]);
      for (const result of restored) rememberResult(result);
    }
    if (attemptsToMove.size) await attemptStore.putMany([...attemptsToMove.values()]);
    const dropDangling = new Set();
    const recovered = [];
    for (const [resultId, ref] of dangling) {
      let exists = false;
      try {
        exists = await fileExists(ref.path);
      } catch {
        exists = false;
      }
      if (!exists) {
        dropDangling.add(resultId);
        continue;
      }
      recovered.push({
        resultId,
        tagId: ref.tagId,
        prompt: String(ref.prompt || ''),
        negativePrompt: '',
        provider: 'openai',
        localRelativePath: String(ref.path),
        status: 'available',
        storageMode: 'direct',
        createdAt: String(ref.createdAt || now()),
        favorite: false,
        recovered: true,
        schemaVersion: SCHEMA_VERSION,
      });
    }
    if (recovered.length) {
      const restored = await metadataStore.putMany(recovered);
      for (const result of restored) rememberResult(result);
    }

    const leanByTagId = new Map();
    let deletedImages = 0;
    let changed = false;
    for (const container of containers) {
      for (const tag of container.metadata.tags) {
        if (!tag?.tagId) continue;
        let lean = leanByTagId.get(tag.tagId);
        if (!lean) {
          lean = leanTag(tag, lookup, { dropDangling });
          const victims = selectResultEvictions(lean.resultRefs, lookup);
          if (victims.length) {
            const removed = new Set(await evictResults(victims));
            deletedImages += removed.size;
            lean = leanTag({ ...lean, resultRefs: lean.resultRefs.filter(ref => !removed.has(ref.resultId)) }, lookup);
          }
          leanByTagId.set(tag.tagId, lean);
        }
        const previous = JSON.stringify(tag);
        rebuildInPlace(tag, clone(lean));
        if (JSON.stringify(tag) !== previous) changed = true;
      }
    }
    if (changed) await saveChat([...new Set(containers.map(container => container.message))]);
    const after = chatTagsFootprint(chat);
    console.info(`[画笺] 瘦身后：生图标签数据共 ${after.bytes} 字节，${describeFootprint(after)}`);
    return {
      dryRun: false,
      before,
      after,
      messages: chat.length,
      tags: tagCount,
      legacyTags: legacyTagCount,
      movedAttempts: attemptsToMove.size,
      restoredResults: orphans.size + recovered.length,
      danglingRefs: dangling.size,
      deletedImages,
      droppedRefs: dropDangling.size,
      changed,
    };
  }

  return {
    mode: () => namespace.settings.executionMode || 'direct',
    health: async () => ({
      mode: 'direct',
      version: VERSION,
      corsRequired: true,
      storage: 'sillytavern-images',
    }),
    getSettings: async () => {
      await ensureReady();
      return clone(namespace.settings);
    },
    updateSettings: async patch => {
      namespace.settings = normalizeSettings({
        ...namespace.settings,
        ...patch,
        updatedAt: now(),
        schemaVersion: SCHEMA_VERSION,
      });
      await savePreferences();
      return clone(namespace.settings);
    },
    getPresets: async () => ({
      activePresetId: namespace.activePresetId,
      items: namespace.presets.map(preset => publicPreset(preset, getApiKey(preset.id))),
    }),
    getNovelAi: async () => ({
      config: publicNovelAiConfig(),
      activeArtistPresetId: namespace.activeArtistPresetId,
      artistPresets: clone(namespace.artistPresets),
    }),
    updateNovelAi: async patch => {
      if (typeof patch?.apiKey === 'string' && patch.apiKey) setNovelAiKey(patch.apiKey);
      const next = { ...patch };
      delete next.apiKey;
      Object.assign(namespace.novelAi, normalizeNovelAiConfig({ ...namespace.novelAi, ...next }), {
        updatedAt: now(),
        schemaVersion: SCHEMA_VERSION,
      });
      await savePreferences();
      return publicNovelAiConfig();
    },
    clearNovelAiSecret: async () => {
      setNovelAiKey('');
      return { cleared: true };
    },
    selectArtistPreset: async presetId => {
      const preset = artistPresetById(presetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选画师串预设');
      namespace.activeArtistPresetId = preset.id;
      await savePreferences();
      return clone(preset);
    },
    createArtistPreset: async ({
      name = '新画师串',
      prompt = '',
      negativePrompt = '',
    } = {}) => {
      const timestamp = now();
      const preset = normalizeArtistPreset({
        id: uuid(),
        name,
        prompt,
        negativePrompt,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: SCHEMA_VERSION,
      });
      namespace.artistPresets.push(preset);
      namespace.activeArtistPresetId = preset.id;
      await savePreferences();
      return clone(preset);
    },
    updateArtistPreset: async (presetId, patch) => {
      const preset = artistPresetById(presetId || namespace.activeArtistPresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到要保存的画师串预设');
      Object.assign(preset, normalizeArtistPreset({ ...preset, ...patch }), {
        id: preset.id,
        updatedAt: now(),
        schemaVersion: SCHEMA_VERSION,
      });
      await savePreferences();
      return clone(preset);
    },
    exportArtistPresets: async ({ presetIds } = {}) => {
      const selectedIds = Array.isArray(presetIds) && presetIds.length
        ? new Set(presetIds.map(String))
        : null;
      const selectedPresets = selectedIds
        ? namespace.artistPresets.filter(preset => selectedIds.has(preset.id))
        : namespace.artistPresets;
      if (!selectedPresets.length) {
        throw new DirectError('VALIDATION_FAILED', '没有找到可导出的画师串预设');
      }
      return createArtistPresetExport(selectedPresets);
    },
    importArtistPresets: async payload => {
      let imported;
      try {
        imported = parseArtistPresetImport(payload);
      } catch (error) {
        throw new DirectError('VALIDATION_FAILED', error.message || '画师串分享文件无效');
      }
      const signatures = new Set(namespace.artistPresets.map(artistPresetSignature));
      const uniqueImports = [];
      let skippedCount = 0;
      for (const value of imported) {
        const signature = artistPresetSignature(value);
        if (signatures.has(signature)) {
          skippedCount += 1;
          continue;
        }
        signatures.add(signature);
        uniqueImports.push(value);
      }
      if (namespace.artistPresets.length + uniqueImports.length > 200) {
        throw new DirectError('VALIDATION_FAILED', '画师串预设总数不能超过 200 条');
      }

      const added = [];
      for (const value of uniqueImports) {
        const timestamp = now();
        const preset = normalizeArtistPreset({
          ...value,
          id: uuid(),
          name: uniqueImportedName(value.name, namespace.artistPresets),
          createdAt: timestamp,
          updatedAt: timestamp,
          schemaVersion: SCHEMA_VERSION,
        });
        namespace.artistPresets.push(preset);
        signatures.add(artistPresetSignature(preset));
        added.push(preset);
      }
      if (added.length) namespace.activeArtistPresetId = added[0].id;
      await savePreferences();
      return {
        importedCount: added.length,
        skippedCount,
        activeArtistPresetId: namespace.activeArtistPresetId,
        activeArtistPreset: clone(activeArtistPreset()),
        artistPresets: clone(namespace.artistPresets),
      };
    },
    deleteArtistPreset: async presetId => {
      if (namespace.artistPresets.length <= 1) {
        throw new DirectError('VALIDATION_FAILED', '至少需要保留一个画师串预设');
      }
      const index = namespace.artistPresets.findIndex(item => item.id === presetId);
      if (index < 0) throw new DirectError('VALIDATION_FAILED', '找不到要删除的画师串预设');
      namespace.artistPresets.splice(index, 1);
      if (namespace.activeArtistPresetId === presetId) {
        namespace.activeArtistPresetId = namespace.artistPresets[
          Math.min(index, namespace.artistPresets.length - 1)
        ].id;
      }
      await savePreferences();
      return { deleted: true, activeArtistPreset: clone(activeArtistPreset()) };
    },
    selectPreset: async presetId => {
      const preset = presetById(presetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      namespace.activePresetId = preset.id;
      await savePreferences();
      return publicPreset(preset, getApiKey(preset.id));
    },
    createPreset: async ({ name = '新预设' } = {}) => {
      const timestamp = now();
      const preset = normalizePreset({
        ...clone(DEFAULT_PRESET),
        id: uuid(),
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: SCHEMA_VERSION,
      });
      namespace.presets.push(preset);
      namespace.activePresetId = preset.id;
      await savePreferences();
      return publicPreset(preset, '');
    },
    updatePreset: async (presetId, patch) => {
      if (patch == null && presetId && typeof presetId === 'object') {
        patch = presetId;
        presetId = namespace.activePresetId;
      }
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到要保存的 API 预设');
      if (typeof patch?.apiKey === 'string' && patch.apiKey) setApiKey(preset.id, patch.apiKey);
      const next = { ...patch };
      delete next.apiKey;
      delete next.id;
      Object.assign(preset, normalizePreset({ ...preset, ...next }), {
        id: preset.id,
        updatedAt: now(),
        schemaVersion: SCHEMA_VERSION,
      });
      await savePreferences();
      return publicPreset(preset, getApiKey(preset.id));
    },
    deletePreset: async presetId => {
      if (namespace.presets.length <= 1) {
        throw new DirectError('VALIDATION_FAILED', '至少需要保留一个 API 预设');
      }
      const index = namespace.presets.findIndex(item => item.id === presetId);
      if (index < 0) throw new DirectError('VALIDATION_FAILED', '找不到要删除的 API 预设');
      const [removed] = namespace.presets.splice(index, 1);
      setApiKey(removed.id, '');
      if (namespace.settings.backupPresetId === removed.id) namespace.settings.backupPresetId = '';
      if (namespace.activePresetId === removed.id) {
        namespace.activePresetId = namespace.presets[Math.min(index, namespace.presets.length - 1)].id;
      }
      await savePreferences();
      return {
        deleted: true,
        activePreset: publicPreset(activePreset(), getApiKey(namespace.activePresetId)),
      };
    },
    clearSecret: async presetId => {
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      setApiKey(preset.id, '');
      return { cleared: true };
    },
    listModels: async presetId => {
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      const models = await listModelsDirect({
        preset,
        apiKey: getApiKey(preset.id),
        settings: namespace.settings,
      });
      preset.cachedModels = models;
      preset.modelsFetchedAt = now();
      await savePreferences();
      return { models: clone(models) };
    },
    testPreset: async presetId => {
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      const models = await listModelsDirect({
        preset,
        apiKey: getApiKey(preset.id),
        settings: namespace.settings,
      });
      return { ok: true, modelCount: models.length };
    },
    resolveTags,
    generate,
    attempt: async attemptId => {
      await ensureReady();
      const attempt = attemptStore.get(attemptId);
      if (!attempt) throw new DirectError('VALIDATION_FAILED', '找不到生成记录');
      return clone(hydrateAttempt(attempt, findTag(attempt.tagId)?.tag?.prompt));
    },
    cancel,
    gallery,
    galleryMetadata,
    cleanupGallery,
    deleteResult,
    setFavorite,
    fileUrl,
    downloadUrl: fileUrl,
    hasResult: resultId => resultIndex.has(resultId),
    slimChat,
    /* 一键删除标签后，它的生成记录也一起清掉（硬删除）。 */
    forgetTag: async tagId => {
      await ensureReady();
      await attemptStore.removeForTag(tagId);
    },
  };
}
