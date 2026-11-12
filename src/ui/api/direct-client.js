import {
  DEFAULT_ARTIST_PRESET,
  DEFAULT_NOVELAI_CONFIG,
  DEFAULT_PRESET,
  DEFAULT_SETTINGS,
  MAX_PRESET_REFERENCES,
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
import { THUMBNAIL_FOLDER, createThumbnail } from '../media/thumbnail.js';
import { createSillyTavernAttemptStore } from './attempt-store.js';
import {
  createArtistPresetExport,
  parseArtistPresetImport,
} from './artist-preset-transfer.js';
import { normalizeRetentionSettings, selectCleanupCandidates } from '../gallery/retention.js';
import { normalizeThemeMode } from '../theme/theme.js';
import {
  isLegacyMetadata,
  locateTag,
  metadataTagIds,
  reconcileMessage as reconcileMessageIdentity,
} from '../state/tag-identity.js';
import { parseDrawTags, shouldProcessMessage } from '../parser/draw-parser.js';
import {
  chatTagFileName,
  createSillyTavernChatTagStore,
  normalizeTagRecord,
  promptHash,
} from './chat-tag-store.js';
import {
  MAX_RESULTS_PER_TAG,
  buildResultRefs,
  displayableResultIds,
  hasLegacyFields,
  hydrateAttempt,
  leanTag,
  normalizeLatestResultId,
  selectResultEvictions,
  slimAttempt,
  tagResultIds,
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
  /* 1.10.0 参考图组：组、默认组、按角色卡的绑定。 */
  'referenceSets',
  'defaultReferenceSetId',
  'referenceBindings',
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

/* 参考图列表：只留路径这类小字段，最多 MAX_PRESET_REFERENCES 张。 */
function normalizeReferences(value) {
  return (Array.isArray(value) ? value : [])
    .filter(item => item && typeof item.path === 'string' && item.path)
    .slice(0, MAX_PRESET_REFERENCES)
    .map(item => ({
      id: String(item.id || uuid()),
      path: String(item.path),
      name: String(item.name || '').slice(0, 80),
      addedAt: String(item.addedAt || ''),
    }));
}

/* 参考图组：{ id, name, references, useReferences, referenceFidelity }。 */
function normalizeReferenceSet(value = {}) {
  return {
    id: String(value.id || uuid()),
    name: String(value.name || '参考图组').trim().slice(0, 60) || '参考图组',
    references: normalizeReferences(value.references),
    useReferences: value.useReferences !== false,
    referenceFidelity: value.referenceFidelity === 'high' ? 'high' : '',
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || ''),
  };
}

function referenceSignature(references) {
  return references.map(item => item.path).join('\n');
}

/* 1.10.0 参考图组：参考图从 API 预设里拿出来，全局一份，换渠道不变；每个角色卡可以记住用哪一组。
   老数据：每个预设上的参考图各成一组（同样几张只留一组，组名用先出现的预设名），当前预设那组设为默认组；
   预设上不再带参考图。图片文件不动。 */
function migrateReferenceSets(namespace) {
  if (!Array.isArray(namespace.referenceSets)) namespace.referenceSets = [];
  namespace.referenceSets = namespace.referenceSets.map(normalizeReferenceSet);
  const bySignature = new Map(namespace.referenceSets.map(set => [referenceSignature(set.references), set]));
  for (const preset of namespace.presets) {
    const references = normalizeReferences(preset.references);
    if (references.length) {
      const signature = referenceSignature(references);
      let set = bySignature.get(signature);
      if (!set) {
        set = normalizeReferenceSet({
          name: preset.name,
          references,
          useReferences: preset.useReferences,
          referenceFidelity: preset.referenceFidelity,
          createdAt: now(),
          updatedAt: now(),
        });
        bySignature.set(signature, set);
        namespace.referenceSets.push(set);
      }
      if (!namespace.defaultReferenceSetId && preset.id === namespace.activePresetId) {
        namespace.defaultReferenceSetId = set.id;
      }
    }
    delete preset.references;
    delete preset.useReferences;
    delete preset.referenceFidelity;
  }
  const ids = new Set(namespace.referenceSets.map(set => set.id));
  const current = namespace.defaultReferenceSetId;
  /* '' 是用户明确选的「默认不带参考图」，留着；没设过或指向已删的组就取第一组。 */
  if (typeof current !== 'string' || (current !== '' && !ids.has(current))) {
    namespace.defaultReferenceSetId = namespace.referenceSets[0]?.id || '';
  }
  const bindings = namespace.referenceBindings && typeof namespace.referenceBindings === 'object'
    ? namespace.referenceBindings
    : {};
  namespace.referenceBindings = Object.fromEntries(
    Object.entries(bindings).filter(([key, setId]) => key && (setId === '' || ids.has(setId))),
  );
}

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
    editsPath: String(value.editsPath || DEFAULT_PRESET.editsPath),
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

/* 1.7.5 之前的默认上限是 30 MB，4K 图装不下；只把没改过的老默认值换成新的，自己设的别的值不动。 */
const LEGACY_MAX_IMAGE_BYTES = 30 * 1024 * 1024;

function normalizeSettings(value = {}) {
  const merged = { ...clone(DEFAULT_SETTINGS), ...value };
  if (Number(merged.maxImageBytes) === LEGACY_MAX_IMAGE_BYTES) merged.maxImageBytes = DEFAULT_SETTINGS.maxImageBytes;
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
  migrateReferenceSets(namespace);
  extensionSettings[MODULE_NAME] = namespace;
  return { namespace, legacyGallery };
}

function maskKey(value) {
  if (!value) return '';
  if (value.length < 8) return '••••••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

/* 出图后缩略图晚 2 秒再做：那一瞬间酒馆要存聊天、要重画，别再挤一件事进去。 */
const THUMBNAIL_DELAY_MS = 2000;

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
  saveSettingsNow,
  keyStorage = globalThis.localStorage,
  galleryStore,
  attemptStore: attemptStoreOption,
  verifyFile,
  /* 画廊缩略图：浏览器里用 createImageBitmap + canvas；测试注入假的；传 null 关掉。 */
  thumbnailer = createThumbnail,
  thumbnailDelayMs = THUMBNAIL_DELAY_MS,
  /* 聊天的生图标签侧文件：默认走酒馆的 user/files；测试注入内存版 (identity) => store。 */
  chatTagStore: chatTagStoreFactory,
}) {
  const { namespace, legacyGallery } = ensureNamespace(extensionSettings);
  const metadataStore = galleryStore || createSillyTavernGalleryMetadataStore(compat);
  const attemptStore = attemptStoreOption || createSillyTavernAttemptStore(compat);

  /* ---------- 聊天的生图标签侧文件（按聊天分，按 tagId 记） ---------- */
  const tagStores = new Map();
  const MAX_TAG_STORES = 6;

  function chatIdentity() {
    return {
      chatId: String(compat.currentChatId?.() || ''),
      characterKey: typeof compat.currentCharacterKey === 'function' ? String(compat.currentCharacterKey() || '') : '',
    };
  }

  function tagStoreKey(identity) {
    return chatTagFileName(identity) || `memory:${identity.chatId}`;
  }

  function tagStoreEntry(identity = chatIdentity()) {
    const key = tagStoreKey(identity);
    let entry = tagStores.get(key);
    if (!entry) {
      const store = typeof chatTagStoreFactory === 'function'
        ? chatTagStoreFactory(identity)
        : createSillyTavernChatTagStore(compat, identity);
      entry = { key, identity, store, ready: null, initialized: false };
      tagStores.set(key, entry);
      /* 切过的聊天留几个在内存里（切回来不用重读），多了把最早的放掉（先把没写完的写完）。 */
      if (tagStores.size > MAX_TAG_STORES) {
        const oldestKey = tagStores.keys().next().value;
        const oldest = tagStores.get(oldestKey);
        tagStores.delete(oldestKey);
        Promise.resolve(oldest?.store?.flush?.()).catch(() => {});
      }
    }
    return entry;
  }

  /* 当前聊天的侧文件：第一次用时读进来，并把旧格式楼层里的标签状态搬进内存（只写侧文件，不动聊天）。 */
  async function ensureTagStore(identity = chatIdentity()) {
    await ensureReady();
    const entry = tagStoreEntry(identity);
    if (!entry.ready) {
      entry.ready = (async () => {
        await entry.store.initialize();
        entry.initialized = true;
        await importLegacyTags(entry.store);
        return entry.store;
      })().catch(error => {
        entry.ready = null;
        entry.initialized = false;
        throw error;
      });
    }
    return entry.ready;
  }

  /* 已经读好的当前聊天侧文件；还没读就是 null（同步路径用）。 */
  function currentTagStore() {
    const entry = tagStores.get(tagStoreKey(chatIdentity()));
    return entry?.initialized ? entry.store : null;
  }

  /* 旧格式楼层里的标签 → 侧文件记录：图片引用按画廊补路径，旧版只有 id 又没记录的丢掉。 */
  function legacyRecord(tag) {
    const lean = leanTag(tag, lookup);
    return normalizeTagRecord({
      promptHash: promptHash(tag?.prompt),
      latestResultId: lean.latestResultId,
      resultRefs: lean.resultRefs,
      autoAttempted: lean.autoAttempted,
      autoSuppressed: lean.autoSuppressed,
    });
  }

  /* 聊天里还带着旧格式（tags 数组）的容器：每一楼当前的 extra，和滑动存档 swipe_info[].extra 里的副本。 */
  function legacyContainers(chat) {
    const containers = [];
    for (const [messageId, message] of (Array.isArray(chat) ? chat : []).entries()) {
      const active = message?.extra?.stImageAtelier;
      if (isLegacyMetadata(active)) containers.push({ message, messageId, metadata: active, placement: 'active', swipeId: null });
      const swipes = Array.isArray(message?.swipe_info) ? message.swipe_info : [];
      for (const [swipeId, swipe] of swipes.entries()) {
        const metadata = swipe?.extra?.stImageAtelier;
        if (isLegacyMetadata(metadata)) containers.push({ message, messageId, metadata, placement: 'swipe', swipeId });
      }
    }
    return containers;
  }

  /* 2.0.0 之前的楼层把标签状态（甚至整份生成记录、图片记录）写在聊天里。读聊天时只把它们搬进侧文件和画廊，
     聊天一个字不动——改聊天只在用户点「整理旧数据」时做一次。侧文件里已经有的不覆盖。 */
  async function importLegacyTags(store) {
    const containers = legacyContainers(compat.chat());
    if (!containers.length) return;
    const orphans = new Map();
    for (const container of containers) {
      for (const tag of container.metadata.tags) {
        for (const record of Array.isArray(tag?.results) ? tag.results : []) {
          if (!record?.resultId || record.status !== 'available' || !record.localRelativePath) continue;
          if (resultIndex.has(record.resultId) || orphans.has(record.resultId)) continue;
          orphans.set(record.resultId, { ...record, tagId: tag.tagId });
        }
      }
    }
    if (orphans.size) {
      const restored = await metadataStore.putMany([...orphans.values()]);
      for (const result of restored) rememberResult(result);
    }
    const entries = [];
    const seen = new Set();
    const ordered = [
      ...containers.filter(container => container.placement === 'active'),
      ...containers.filter(container => container.placement === 'swipe'),
    ];
    for (const container of ordered) {
      for (const tag of container.metadata.tags) {
        if (!tag?.tagId || seen.has(tag.tagId) || store.has(tag.tagId)) continue;
        seen.add(tag.tagId);
        entries.push([tag.tagId, legacyRecord(tag)]);
      }
    }
    if (entries.length) store.putMany(entries);
  }
  const controllers = new Map();
  /* 画廊记录的内存索引：按 resultId 直接取，按 tagId 找属于这张卡的图，按 messageUuid 找这一楼出过的图。 */
  const resultIndex = new Map();
  const resultsByTag = new Map();
  const resultsByMessage = new Map();
  const memoryKeys = new Map();
  const legacyMigrations = new Map();
  let cleanupPromise = null;
  let readyPromise = null;

  function rememberResult(record) {
    const previous = resultIndex.get(record.resultId);
    if (previous && previous.tagId !== record.tagId) {
      const owned = resultsByTag.get(previous.tagId);
      owned?.delete(record.resultId);
      if (owned && !owned.size) resultsByTag.delete(previous.tagId);
    }
    if (previous?.messageUuid && previous.messageUuid !== record.messageUuid) {
      resultsByMessage.get(previous.messageUuid)?.delete(record.resultId);
    }
    resultIndex.set(record.resultId, record);
    if (!resultsByTag.has(record.tagId)) resultsByTag.set(record.tagId, new Set());
    resultsByTag.get(record.tagId).add(record.resultId);
    if (record.messageUuid) {
      if (!resultsByMessage.has(record.messageUuid)) resultsByMessage.set(record.messageUuid, new Set());
      resultsByMessage.get(record.messageUuid).add(record.resultId);
    }
  }

  function forgetResult(resultId) {
    const record = resultIndex.get(resultId);
    if (!record) return;
    resultIndex.delete(resultId);
    const owned = resultsByTag.get(record.tagId);
    owned?.delete(resultId);
    if (owned && !owned.size) resultsByTag.delete(record.tagId);
    const sameMessage = resultsByMessage.get(record.messageUuid);
    sameMessage?.delete(resultId);
    if (sameMessage && !sameMessage.size) resultsByMessage.delete(record.messageUuid);
  }

  function resetResults() {
    resultIndex.clear();
    resultsByTag.clear();
    resultsByMessage.clear();
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

  /* immediate：当场把设置写盘。参考图这种刚传完的东西不能只靠防抖——手机 Safari 切到后台常常把页面重新载入，
     防抖还没到点就没了，再打开就「还没有参考图」。酒馆没给立即保存的函数时退回防抖。 */
  async function savePreferences({ immediate = false } = {}) {
    await ensureReady();
    if (immediate && typeof saveSettingsNow === 'function') {
      await Promise.resolve(saveSettingsNow());
      return;
    }
    await Promise.resolve(saveSettingsDebounced?.());
  }

  /* 保存聊天之前检查一遍：这几楼的标签数据超过 20 KB 就在控制台警告并列出各字段大小（防复发）。
     默认延后、合并保存（酒馆的 saveChatDebounced：同一秒里不管谁要存都只写一次盘，也错开出图返回那一瞬间）；
     出图、读状态的改动都不急——页面真在这一秒里没了，resolveTags 也能按画廊把图接回卡片。
     只有「瘦身当前聊天」要当场写完（immediate）。 */
  async function saveChat(messages = [], { immediate = false } = {}) {
    const chat = compat.chat();
    for (const message of new Set(messages)) {
      const messageId = chat.indexOf(message);
      if (messageId >= 0) warnIfHeavy(message, messageId);
    }
    if (!immediate && typeof compat.saveSoon === 'function') return compat.saveSoon();
    return compat.save();
  }

  /* 在聊天里找这个标签（当前这一版或滑动存档），连同侧文件里的记录。侧文件还没读好、或记录丢了
     （换过聊天名、分支出来的聊天）就按楼里的信息临时拼一条，之后 resolveTags 会按画廊补齐并写回。 */
  function findTag(tagId) {
    const found = locateTag(compat.chat(), tagId, { isStreaming: compat.isStreaming });
    if (!found) return null;
    const store = currentTagStore();
    const record = store?.get(tagId)
      || (found.tag ? legacyRecord(found.tag) : normalizeTagRecord({ promptHash: promptHash(found.prompt) }));
    return { ...found, tagId, record, store };
  }

  /* 改一条标签的状态：写进它所在聊天的侧文件。内容没变 store 自己会跳过，不会多写。 */
  function updateRecord(store, tagId, patch) {
    const target = store || currentTagStore();
    if (!target) return null;
    return target.update(tagId, patch);
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
    const { record, prompt } = found;
    const available = displayableResultIds(record, lookup);
    const attempts = attemptStore.forTag(tagId).map(item => hydrateAttempt(item, prompt));
    const autoAttempted = Boolean(record.autoAttempted
      || attempts.some(attempt => attempt.attemptId === `auto:${tagId}`));
    /* 自动生图的标记记在侧文件里，不动聊天。 */
    if (autoAttempted && record.autoAttempted !== true) updateRecord(found.store, tagId, { autoAttempted: true });
    return {
      tagId,
      tag: {
        tagId,
        messageUuid: found.metadata?.messageUuid || null,
        prompt,
        ordinal: found.ordinal,
        placement: found.placement,
        resultIds: available,
        latestResultId: normalizeLatestResultId(record, lookup),
        autoAttempted,
        autoSuppressed: record.autoSuppressed === true,
      },
      attempts,
      results: clone(available.map(resultId => resultIndex.get(resultId))),
    };
  }

  /* 旧版把生成记录整份复制在聊天里。读状态时把它们搬进独立存储（精简后）；聊天里那份不动，
     由「整理旧数据」一次清掉。搬运中途再读到同一个标签不重复搬。 */
  function migrateLegacyAttempts(tagId) {
    if (legacyMigrations.has(tagId)) return legacyMigrations.get(tagId);
    const found = findTag(tagId);
    const legacy = Array.isArray(found?.tag?.attempts) ? found.tag.attempts : [];
    const fresh = legacy
      .filter(item => item?.attemptId && !attemptStore.has(item.attemptId))
      .map(item => slimAttempt({ ...item, tagId }, found.prompt));
    if (!fresh.length) return Promise.resolve();
    const pending = attemptStore.putMany(fresh)
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
        throw new DirectError('IMAGE_DOWNLOAD_FAILED', `图片超过 ${Math.round(namespace.settings.maxImageBytes / 1024 / 1024)} MB`);
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

  /* 上游给的 base64 原样上传，不再整张解成字节再重新编码：以前一张几 MB 的图在内存里同时有响应原文、
     解出来的字节、重编码的 base64、上传请求体四份。现在只解开头几十个字节认格式、按长度算大小。 */
  function inspectBase64Image(value) {
    const clean = String(value || '').replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '');
    if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
      throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'Base64 解码失败');
    }
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    let head;
    try {
      head = base64ToBytes(clean.slice(0, 64));
    } catch (error) {
      throw new DirectError('UPSTREAM_RESPONSE_INVALID', error?.message || 'Base64 解码失败');
    }
    return { image: clean, byteLength: Math.floor((clean.length * 3) / 4) - padding, type: detectImageType(head) };
  }

  async function saveSource(source, input, attempt, signal) {
    let payload;
    if (source.sourceType === 'base64') {
      payload = inspectBase64Image(source.value);
    } else {
      const bytes = await bytesFromSource(source, signal);
      payload = { image: '', bytes, byteLength: bytes.byteLength, type: detectImageType(bytes) };
    }
    if (payload.byteLength > namespace.settings.maxImageBytes) {
      throw new DirectError('IMAGE_DOWNLOAD_FAILED', `图片超过 ${Math.round(namespace.settings.maxImageBytes / 1024 / 1024)} MB`);
    }
    const { type, byteLength } = payload;
    if (!type) throw new DirectError('UPSTREAM_RESPONSE_INVALID', '仅支持 PNG、JPEG、WebP');
    const resultId = uuid();
    const uploaded = await requestSt('/api/images/upload', {
      image: payload.image || bytesToBase64(payload.bytes),
      format: type.extension,
      ch_name: 'st-image-atelier',
      filename: resultId,
    });
    /* 传完就把图片数据的引用放掉，换成路径。 */
    payload = null;
    source.value = null;
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
      references: Array.isArray(attempt.references) ? [...attempt.references] : [],
      localRelativePath: uploaded.path,
      mimeType: type.mimeType,
      byteSize: byteLength,
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
    /* 缩略图跟着原图走：原图删了它也删；删不掉只记一条，不拦着。 */
    if (result.thumbnailPath) {
      await requestSt('/api/images/delete', { path: result.thumbnailPath }).catch(error => {
        if (error.status !== 404) console.warn('[画笺] 删除缩略图失败', result.resultId, error);
      });
    }
  }

  /* ---------- 画廊缩略图 ---------- */
  const thumbnailJobs = new Map();
  const thumbnailRuns = new Set();

  function thumbnailsSupported() {
    if (typeof thumbnailer !== 'function') return false;
    return thumbnailer !== createThumbnail || typeof createImageBitmap === 'function';
  }

  /* 画廊格子用的地址：有缩略图用缩略图，没有退回原图。 */
  function thumbnailUrl(resultId) {
    const result = resultIndex.get(resultId);
    return normalizePath(result?.thumbnailPath || result?.localRelativePath);
  }

  /* 给一张已经存好的图做缩略图：从酒馆读回原图、缩到长边 768、JPEG 存进自己的目录、路径记在画廊记录上。
     原图一个字节不动。同一张图同时来几次只做一次；做不了返回 null，画廊退回用原图。 */
  function ensureThumbnail(resultId) {
    const record = resultIndex.get(resultId);
    if (!record?.localRelativePath) return Promise.resolve(null);
    if (record.thumbnailPath) return Promise.resolve(record.thumbnailPath);
    if (!thumbnailsSupported()) return Promise.resolve(null);
    if (thumbnailJobs.has(resultId)) return thumbnailJobs.get(resultId);
    const job = (async () => {
      const response = await fetch(normalizePath(record.localRelativePath), { credentials: 'same-origin' });
      if (!response.ok) {
        throw new DirectError('LOCAL_SAVE_FAILED', `读取原图失败（HTTP ${response.status}）`, response.status);
      }
      const thumbnail = await thumbnailer(await response.blob());
      if (!thumbnail?.blob) return null;
      const bytes = new Uint8Array(await thumbnail.blob.arrayBuffer());
      const uploaded = await requestSt('/api/images/upload', {
        image: bytesToBase64(bytes),
        format: 'jpeg',
        ch_name: THUMBNAIL_FOLDER,
        filename: `${resultId}-thumb`,
      });
      if (!resultIndex.has(resultId)) {
        /* 做的这会儿图被删了：缩略图文件也不留。 */
        await requestSt('/api/images/delete', { path: uploaded.path }).catch(() => {});
        return null;
      }
      const updated = await metadataStore.update(resultId, {
        thumbnailPath: uploaded.path,
        thumbnailWidth: thumbnail.width,
        thumbnailHeight: thumbnail.height,
      });
      if (updated) rememberResult(updated);
      return uploaded.path;
    })();
    thumbnailJobs.set(resultId, job);
    job
      .catch(error => console.warn('[画笺] 生成画廊缩略图失败（原图不受影响）', resultId, error))
      .finally(() => thumbnailJobs.delete(resultId));
    return job;
  }

  /* 出图后晚几秒在后台做，不耽误卡片，失败也不影响出图。 */
  function scheduleThumbnails(resultIds) {
    if (!thumbnailsSupported() || !resultIds.length) return;
    const start = () => {
      const run = (async () => {
        for (const resultId of resultIds) await ensureThumbnail(resultId).catch(() => null);
      })();
      thumbnailRuns.add(run);
      run.finally(() => thumbnailRuns.delete(run));
    };
    if (thumbnailDelayMs > 0) {
      const timer = setTimeout(start, thumbnailDelayMs);
      timer.unref?.();
    } else {
      start();
    }
  }

  /* 1.9.0 之前的图没有缩略图：最新的先补，一次只做一张，onProgress 报进度，signal 中止。 */
  async function backfillThumbnails({ onProgress, signal, limit = Infinity } = {}) {
    await ensureReady();
    const pending = metadataStore.records()
      .filter(record => record.status === 'available' && record.localRelativePath && !record.thumbnailPath)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Number.isFinite(limit) ? limit : undefined)
      .map(record => record.resultId);
    const summary = { total: pending.length, done: 0, failed: 0, aborted: false };
    for (const resultId of pending) {
      if (signal?.aborted) {
        summary.aborted = true;
        break;
      }
      const path = await ensureThumbnail(resultId).catch(() => null);
      if (path) summary.done += 1;
      else summary.failed += 1;
      onProgress?.({ ...summary, resultId });
    }
    return summary;
  }

  /* ---------- 参考图（图生图） ---------- */
  const REFERENCE_FOLDER = 'st-image-atelier-refs';

  function maxImageMegabytes() {
    return Math.round(namespace.settings.maxImageBytes / 1024 / 1024);
  }

  /* 把一张参考图存进酒馆的图片目录（和生成结果分开放），只回路径。相册选的、设置里加的都走这里。 */
  async function uploadReferenceImage({ bytes, filename = '' } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!data.byteLength) throw new DirectError('VALIDATION_FAILED', '参考图是空的', 400, false, '参考图是空的');
    if (data.byteLength > namespace.settings.maxImageBytes) {
      throw new DirectError('VALIDATION_FAILED', `参考图超过 ${maxImageMegabytes()} MB`, 400, false, `参考图超过 ${maxImageMegabytes()} MB`);
    }
    const type = detectImageType(data);
    if (!type) throw new DirectError('VALIDATION_FAILED', '参考图只支持 PNG、JPEG、WebP', 400, false, '参考图只支持 PNG、JPEG、WebP');
    const id = uuid();
    const uploaded = await requestSt('/api/images/upload', {
      image: bytesToBase64(data),
      format: type.extension,
      ch_name: REFERENCE_FOLDER,
      filename: `ref-${id}`,
    });
    return {
      id,
      path: uploaded.path,
      name: String(filename || '').slice(0, 80),
      mimeType: type.mimeType,
      byteSize: data.byteLength,
    };
  }

  /* 这次要带的参考图：明确指定的（卡片上「以这张为参考」、相册选的）排前面，再带预设里的角色参考图
     （开着「自动带上」时），同一张不重复，最多 MAX_PRESET_REFERENCES 张。 */
  /* ---------- 参考图组：这个角色出图用哪组 ---------- */
  function referenceSetById(setId) {
    return namespace.referenceSets.find(set => set.id === setId) || null;
  }

  function characterKey() {
    return typeof compat.currentCharacterKey === 'function' ? String(compat.currentCharacterKey() || '') : '';
  }

  /* 单独设置过的角色：组 id 或 ''（不带参考图）；没设置过返回 null（跟默认组）。 */
  function boundSetId(key) {
    return key && Object.prototype.hasOwnProperty.call(namespace.referenceBindings, key)
      ? namespace.referenceBindings[key]
      : null;
  }

  function resolveReferenceSet(key = characterKey()) {
    const bound = boundSetId(key);
    const setId = bound === null ? namespace.defaultReferenceSetId : bound;
    return setId ? referenceSetById(setId) : null;
  }

  function referenceOverview(extra = {}) {
    const key = characterKey();
    const bound = boundSetId(key);
    return {
      sets: clone(namespace.referenceSets),
      defaultSetId: namespace.defaultReferenceSetId,
      character: {
        key,
        name: typeof compat.currentCharacterName === 'function' ? String(compat.currentCharacterName() || '') : '',
        setId: bound,
        follows: bound === null,
      },
      activeSetId: resolveReferenceSet(key)?.id || '',
      ...extra,
    };
  }

  function requireReferenceSet(setId) {
    const set = referenceSetById(setId);
    if (!set) throw new DirectError('VALIDATION_FAILED', '找不到这组参考图', 400, false, '找不到这组参考图，可能已经删掉了');
    return set;
  }

  function planReferences(input, set) {
    const explicit = [];
    for (const item of Array.isArray(input.references) ? input.references : []) {
      if (item?.resultId) {
        const record = resultIndex.get(item.resultId);
        if (record?.localRelativePath) explicit.push({ path: record.localRelativePath, source: 'result', resultId: item.resultId });
      } else if (typeof item?.path === 'string' && item.path) {
        explicit.push({ path: item.path, source: item.temporary ? 'temporary' : 'path' });
      }
    }
    const fromSet = set?.useReferences !== false
      ? (set?.references || []).map(reference => ({ path: reference.path, source: 'set' }))
      : [];
    const seen = new Set();
    const planned = [];
    for (const item of [...explicit, ...fromSet]) {
      if (!item.path || seen.has(item.path)) continue;
      seen.add(item.path);
      planned.push(item);
      if (planned.length >= MAX_PRESET_REFERENCES) break;
    }
    return planned;
  }

  /* 从酒馆读回参考图的文件（同源，不受 CORS 限制），认一下格式。 */
  async function loadReference(item, signal) {
    let response;
    try {
      response = await fetch(normalizePath(item.path), { credentials: 'same-origin', signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DirectError('VALIDATION_FAILED', `读取参考图失败：${item.path}`, 400, false, '读取参考图失败，这张图可能已经不在酒馆里了');
    }
    if (!response.ok) {
      throw new DirectError('VALIDATION_FAILED', `读取参考图失败（HTTP ${response.status}）：${item.path}`, 400, false, `读取参考图失败（HTTP ${response.status}），这张图可能已经不在酒馆里了`);
    }
    const blob = await response.blob();
    if (blob.size > namespace.settings.maxImageBytes) {
      throw new DirectError('VALIDATION_FAILED', `参考图超过 ${maxImageMegabytes()} MB：${item.path}`, 400, false, `参考图超过 ${maxImageMegabytes()} MB`);
    }
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const type = detectImageType(head)
      || (String(blob.type || '').startsWith('image/') ? { mimeType: blob.type, extension: blob.type.split('/')[1] } : null);
    if (!type) throw new DirectError('VALIDATION_FAILED', `参考图不是 PNG / JPEG / WebP：${item.path}`, 400, false, '参考图不是 PNG / JPEG / WebP');
    return {
      blob: blob.type ? blob : new Blob([blob], { type: type.mimeType }),
      mimeType: type.mimeType,
      name: `reference.${type.extension}`,
    };
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

  /* 每张卡最多留 MAX_RESULTS_PER_TAG 张：超了就删最早的（收藏的不删，刚画好的不删）。记录写进侧文件。 */
  async function enforceResultCap(store, tagId, record, protect = new Set()) {
    const victims = selectResultEvictions(record.resultRefs || [], lookup, { protect });
    if (!victims.length) return { removed: [], record };
    const removed = await evictResults(victims);
    if (!removed.length) return { removed, record };
    const dropped = new Set(removed);
    const next = {
      ...record,
      resultRefs: buildResultRefs(record, tagResultIds(record).filter(resultId => !dropped.has(resultId)), lookup),
    };
    if (dropped.has(next.latestResultId) || !next.latestResultId) {
      next.latestResultId = normalizeLatestResultId(next, lookup);
    }
    const updated = updateRecord(store, tagId, { resultRefs: next.resultRefs, latestResultId: next.latestResultId })
      || normalizeTagRecord(next);
    console.info(
      `[画笺] 这张卡的历史超过 ${MAX_RESULTS_PER_TAG} 张，已删除最早的 ${removed.length} 张（收藏的不删）`,
      tagId,
    );
    return { removed, record: updated };
  }

  /* 认领：这张卡一张图都没有，画廊里却有「同一楼（messageUuid）、同一段提示词」的图，挂在一个这个聊天里
     已经没人用的旧 ID 上。2.0.0～2.0.2 在侧文件读不到时会给整楼换新 ID，图就这样从卡片上掉了（还在画廊里）。
     把那个旧 ID 名下的图全部改挂到现在的 ID 上：只改画廊记录，不动聊天、不动图片文件。返回认领到的记录。 */
  let adoptedCount = 0;
  async function adoptOrphanResults(tagId, found) {
    const messageUuid = found.metadata?.messageUuid;
    if (!messageUuid || !found.prompt) return [];
    const sameMessage = [...(resultsByMessage.get(messageUuid) || [])]
      .map(resultId => resultIndex.get(resultId))
      .filter(record => record?.tagId && record.tagId !== tagId);
    if (!sameMessage.length) return [];
    const hash = promptHash(found.prompt);
    const chat = compat.chat();
    const inUse = new Map();
    const staleTagIds = new Set();
    for (const record of sameMessage) {
      if (promptHash(record.prompt) !== hash) continue;
      if (!inUse.has(record.tagId)) {
        inUse.set(record.tagId, Boolean(locateTag(chat, record.tagId, { isStreaming: compat.isStreaming })));
      }
      if (!inUse.get(record.tagId)) staleTagIds.add(record.tagId);
    }
    const adopted = [];
    for (const staleTagId of staleTagIds) {
      for (const record of ownedResults(staleTagId)) {
        const updated = await metadataStore.update(record.resultId, { tagId });
        if (!updated) continue;
        rememberResult(updated);
        adopted.push(updated);
      }
    }
    if (adopted.length) {
      adoptedCount += adopted.length;
      console.info(`[画笺] 认领回 ${adopted.length} 张挂在旧标签上的图`, tagId);
    }
    return adopted;
  }

  /* adoptOrphans：加载聊天时（不是新消息）顺手认领挂在旧 ID 上的图，见 adoptOrphanResults。 */
  async function resolveTags(tagIds, { adoptOrphans = false } = {}) {
    await ensureReady();
    const store = await ensureTagStore();
    for (const tagId of tagIds) {
      const found = findTag(tagId);
      if (!found) continue;
      if (Array.isArray(found.tag?.attempts)) void migrateLegacyAttempts(tagId);
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
      /* 画廊里属于这张卡的图，记录里都要有：画到一半切走聊天、再回来时侧文件里还没记上。
         记录本身一样就不会写；侧文件里还没有这条（换过聊天名、分支出来的聊天）时补一条。 */
      const { record } = found;
      const ids = tagResultIds(record);
      let adoptedAuto = false;
      if (adoptOrphans && !ids.length && !ownedResults(tagId).length) {
        const adopted = await adoptOrphanResults(tagId, found);
        adoptedAuto = adopted.some(result => String(result.attemptId || '').startsWith('auto:'));
      }
      const known = new Set(ids);
      const missing = ownedResults(tagId)
        .filter(result => !known.has(result.resultId))
        .map(result => result.resultId);
      const next = missing.length
        ? { ...record, resultRefs: buildResultRefs(record, [...ids, ...missing], lookup) }
        : { ...record };
      next.latestResultId = normalizeLatestResultId(next, lookup);
      if (adoptedAuto) next.autoAttempted = true;
      store.update(tagId, next);
    }
    return tagIds.map(stateOf);
  }

  /* 识别一楼：正文里的 <draw> 对上 tagId，记录放进侧文件，楼里只放引用 { messageUuid, tagIds }。
     返回给卡片用的标签视图和「聊天有没有改」：只有出现新标签、标签变了才改；旧格式楼层原样不动
     （它的状态已经搬进侧文件），除非它的标签变了才升级成引用。created 是这一次才拿到新 ID 的标签。 */
  async function reconcileMessage(messageId) {
    const message = compat.chat()[Number(messageId)];
    if (!shouldProcessMessage(message)) return { tags: [], changed: false, messageUuid: null, created: [] };
    const parsed = parseDrawTags(message.mes);
    if (!parsed.length) {
      return { tags: [], changed: false, messageUuid: message.extra?.stImageAtelier?.messageUuid || null, created: [] };
    }
    const store = await ensureTagStore();
    const previousIds = metadataTagIds(message.extra?.stImageAtelier);
    const result = reconcileMessageIdentity(message, parsed, { records: tagId => store.get(tagId) });
    store.putMany(Object.entries(result.records));
    let changed = false;
    if (result.refChanged && (!result.legacy || result.identityChanged)) {
      message.extra ??= {};
      message.extra.stImageAtelier = result.ref;
      changed = true;
      /* 这一楼里被换掉的旧 ID（提示词改了、流式输出时写到一半的）：没出过图、没生成过、聊天里别处（另一个
         滑动版本的存档）也不再用它的，记录不留，免得侧文件越攒越多。 */
      for (const tagId of previousIds) {
        if (result.ref.tagIds.includes(tagId)) continue;
        const record = store.get(tagId);
        if (!record || record.resultRefs.length || ownedResults(tagId).length || attemptStore.forTag(tagId).length) continue;
        if (locateTag(compat.chat(), tagId, { isStreaming: compat.isStreaming })) continue;
        store.remove(tagId);
      }
    }
    return { tags: result.tags, messageUuid: result.ref.messageUuid, changed, created: result.created };
  }

  /* 页面转入后台、要关掉之前：把还在等合并写的（画廊、生成记录、各聊天的侧文件）立刻写掉。
     手机上切走页面后定时器会被冻住，页面再被系统回收，没写完的就丢了——图明明画好了，回来却显示「生成被中断」。 */
  function flushPending() {
    return Promise.allSettled([
      metadataStore.flush(),
      attemptStore.flush(),
      ...[...tagStores.values()].filter(entry => entry.initialized).map(entry => entry.store.flush()),
    ]);
  }

  async function generate(input) {
    await ensureReady();
    /* 只给眼前这一版的卡片出图。排着队的旧标签（这一层已经重新生成、正在生成新的滑动版本、
       改动或删除过）在扣费前就停下。 */
    const found = locateTag(compat.chat(), input.tagId, { isStreaming: compat.isStreaming });
    if (found?.placement !== 'active') throw new DirectError('TAG_NOT_FOUND', '找不到对应的生图标签', 404);
    const tagPrompt = found.prompt;
    /* 图片引用写进这个聊天的侧文件：现在就把它拿在手里，画完时就算切了聊天也写得回原来那份。 */
    const tagStore = await ensureTagStore();
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
    /* 参考图只有 GPT 这边有：明确指定的加这个角色用的那组。记在生成记录和画廊记录上的只是路径。
       高保真开关记在组上，带图请求读的是 preset.referenceFidelity，抄到这份预设副本上。 */
    const referenceSet = provider === 'novelai' ? null : resolveReferenceSet();
    if (preset) preset.referenceFidelity = referenceSet?.referenceFidelity === 'high' ? 'high' : '';
    const references = provider === 'novelai' ? [] : planReferences(input, referenceSet);

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
      ...(references.length ? { references: references.map(item => item.path) } : {}),
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
    /* 发上游请求前把记录写进独立文件（防重复，这一次当拍就写），但不等它、写失败也不拦着出图：
       内存里的记录照样防重复，终态记录稍后还会再写一次。手机 5G 上等一个几百 KB 的上传再发请求，
       既慢，抖一下就整次出图作废。 */
    persist({ immediate: true }).catch(error => {
      console.warn('[画笺] 发请求前写防重复记录失败，继续出图，稍后再写', error?.details || error?.message || error);
    });
    /* 自动生图再在侧文件里记一笔 autoAttempted：独立存储的记录满了被清掉，也不会再自动画一次。
       内存里当场改、文件马上写，但不等它、写失败也不拦着出图——防重复靠的是上面那条记录。 */
    if (input.requestMode === 'auto' && tagStore.get(input.tagId)?.autoAttempted !== true) {
      const base = tagStore.get(input.tagId) || normalizeTagRecord({ promptHash: promptHash(tagPrompt) });
      tagStore.update(input.tagId, { ...base, autoAttempted: true }, { immediate: true });
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
        /* 参考图从酒馆读回来，和提示词一起走图生图接口。 */
        const loadedReferences = await Promise.all(references.map(item => loadReference(item, controller.signal)));
        sources = await generateImages({
          preset,
          apiKey,
          prompt: input.prompt,
          parameters: attempt.parameters,
          settings: namespace.settings,
          signal: controller.signal,
          references: loadedReferences,
          onCompatibilityRetry: async retry => {
            attempt.compatibilityRetry = retry;
            attempt.statusMessage = retry.message;
            await persist({ persist: false });
            input.onProgress?.(clone(attempt));
          },
          /* 中转把生图做成异步任务：卡片上说一声，正在每隔几秒问它画完没有。 */
          onAsyncJob: async job => {
            attempt.statusMessage = `中转站在后台排队画（异步任务${job.id ? ` ${String(job.id).slice(0, 16)}` : ''}），每隔几秒问一次画完没有…`;
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
      /* 后台那张（之后又 roll 过）画好时，新的那次已经出图，就不抢卡片上显示的那张，只进历史。 */
      const siblings = attemptStore.forTag(input.tagId);
      const position = siblings.findIndex(item => item.attemptId === attempt.attemptId);
      const newerSucceeded = siblings.slice(0, Math.max(0, position)).some(item => item.status === 'succeeded');
      /* 图片引用、当前显示哪张：写进这个聊天的侧文件（按 tagId），聊天文件不动。卡片被滑走、切了聊天
         也一样写得到，滑回去、切回来由 resolveTags 读侧文件接回卡片。 */
      const current = tagStore.get(input.tagId) || normalizeTagRecord({ promptHash: promptHash(tagPrompt) });
      const latestResultId = (!newerSucceeded || !current.latestResultId)
        ? (saved.at(-1)?.resultId || current.latestResultId || null)
        : current.latestResultId;
      const written = tagStore.update(input.tagId, {
        ...current,
        resultRefs: buildResultRefs(current, [...tagResultIds(current), ...saved.map(result => result.resultId)], lookup),
        latestResultId,
      });
      await enforceResultCap(tagStore, input.tagId, written, new Set(saved.map(result => result.resultId)));
      attempt.status = 'succeeded';
      attempt.resultIds = saved.map(result => result.resultId);
      attempt.completedAt = now();
      /* 先改内存再写记录：卡片重绘读到的是「已完成」。聊天不用保存——楼里只有引用，没变。
         终态记录和侧文件都延后合并写，不等它们：图已经存好、引用已经在内存里。 */
      await persist({ persist: false });
      persist().catch(error => console.warn('[画笺] 保存生成记录失败（图片已经存好）', error));
      /* 画廊缩略图晚几秒在后台做（读回原图、缩小、另存一张小图），原图不动。 */
      scheduleThumbnails(saved.map(result => result.resultId));
      return clone(attempt);
    } catch (error) {
      await Promise.allSettled(saved.map(removeFile));
      await metadataStore.removeMany(saved.map(result => result.resultId)).catch(() => {});
      for (const result of saved) forgetResult(result.resultId);
      if (saved.length && tagStore.has(input.tagId)) {
        const discarded = new Set(saved.map(result => result.resultId));
        const current = tagStore.get(input.tagId);
        const ids = tagResultIds(current);
        if (ids.some(resultId => discarded.has(resultId))) {
          const next = { ...current, resultRefs: buildResultRefs(current, ids.filter(resultId => !discarded.has(resultId)), lookup) };
          tagStore.update(input.tagId, {
            ...next,
            latestResultId: discarded.has(next.latestResultId) ? normalizeLatestResultId(next, lookup) : next.latestResultId,
          });
        }
      }
      const cancelled = controller.signal.aborted;
      attempt.status = cancelled ? 'cancelled' : 'failed';
      attempt.errorCode = cancelled ? null : (error.code || 'UPSTREAM_HTTP_ERROR');
      /* 报错的细节（上游回了什么、哪个字段不对）也记进卡片，不只在弹窗里闪一下；说法里已经带着的不重复。 */
      const detail = String(error.details || '').trim();
      const withDetail = detail && !String(error.message || '').includes(detail) ? `：${detail.slice(0, 300)}` : '';
      attempt.errorMessage = cancelled ? '已取消' : `${error.message || '生成失败'}${withDetail}`;
      if (!cancelled && attempt.compatibilityRetry) {
        attempt.errorMessage += `；已尝试移除 ${attempt.compatibilityRetry.adjustedParameters.join('、')} 后重试一次`;
      }
      attempt.completedAt = now();
      persist().catch(() => {});
      if (cancelled) return clone(attempt);
      throw error;
    } finally {
      controllers.delete(attempt.attemptId);
      /* 相册里临时选的参考图用完就删，不在酒馆里越攒越多；预设里的和画廊里的不动。 */
      for (const item of references.filter(reference => reference.source === 'temporary')) {
        removeFile({ localRelativePath: item.path }).catch(error => console.warn('[画笺] 删除临时参考图失败', item.path, error));
      }
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
    attemptStore.put(attempt).catch(error => console.warn('[画笺] 保存取消记录失败', error));
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
    await ensureTagStore();
    const result = resultIndex.get(resultId);
    if (!result) throw new DirectError('VALIDATION_FAILED', '找不到图片');
    await removeFile(result);
    await metadataStore.remove(resultId);
    forgetResult(resultId);
    const found = findTag(result.tagId);
    if (found) {
      const refs = buildResultRefs(found.record, tagResultIds(found.record).filter(id => id !== resultId), lookup);
      const next = { ...found.record, resultRefs: refs };
      updateRecord(found.store, result.tagId, {
        resultRefs: refs,
        latestResultId: normalizeLatestResultId(next, lookup),
        autoSuppressed: true,
      });
    }
    return { resultId, status: 'deleted' };
  }

  async function performGalleryCleanup() {
    /* 两条规则都关着（默认）就什么都不做：不读画廊、不把几千条记录深拷贝一遍。出图后、每小时都会来一次。 */
    const rules = normalizeRetentionSettings(namespace.settings);
    if (!rules.galleryCleanupByAge && !rules.galleryCleanupByCount) {
      return {
        enabled: false,
        candidateCount: 0,
        deletedCount: 0,
        failedCount: 0,
        keptCount: resultIndex.size,
        byAgeCount: 0,
        byCountCount: 0,
        deletedIds: [],
      };
    }
    await ensureReady();
    await ensureTagStore();
    const selection = selectCleanupCandidates(metadataStore.records(), namespace.settings);

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

    const deleted = new Set(deletedIds);
    for (const tagId of affectedTags) {
      const found = findTag(tagId);
      if (!found) continue;
      const refs = buildResultRefs(found.record, tagResultIds(found.record).filter(resultId => !deleted.has(resultId)), lookup);
      const next = { ...found.record, resultRefs: refs };
      updateRecord(found.store, tagId, {
        resultRefs: refs,
        latestResultId: normalizeLatestResultId(next, lookup),
        autoSuppressed: true,
      });
    }

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

  /* 「整理旧数据」：2.0.0 之前的楼层把标签状态、甚至整份生成记录和图片记录写在聊天里。遍历所有楼层
     （含滑动存档 swipe_info[].extra 里的副本）：生成记录搬进独立存储、图片记录补回画廊、引用按路径核对
     （文件在的补回画廊、不在的去掉）、超过每张卡上限的旧图硬删、标签状态写进侧文件，楼里只留
     { messageUuid, tagIds }，最后只保存一次聊天。重复执行没有副作用。dryRun 只算账、不动任何数据。 */
  async function organizeChat({ dryRun = false } = {}) {
    await ensureReady();
    const store = await ensureTagStore();
    const chat = compat.chat();
    const before = chatTagsFootprint(chat);
    const containers = legacyContainers(chat);
    const legacyFloors = new Set(containers.filter(container => container.placement === 'active').map(container => container.messageId)).size;
    const summary = extra => ({
      dryRun,
      before,
      after: before,
      messages: chat.length,
      legacyFloors,
      containers: containers.length,
      tags: 0,
      legacyTags: 0,
      movedAttempts: 0,
      restoredResults: 0,
      danglingRefs: 0,
      deletedImages: 0,
      droppedRefs: 0,
      changed: false,
      ...extra,
    });

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
      return summary({
        tags: tagCount,
        legacyTags: legacyTagCount,
        movedAttempts: attemptsToMove.size,
        restoredResults: orphans.size,
        danglingRefs: dangling.size,
        deletedImages: wouldDelete,
      });
    }
    if (!containers.length) return summary({});

    console.info(`[画笺] 整理前：生图标签数据共 ${before.bytes} 字节，${describeFootprint(before)}`);
    /* 先把要留的搬走、等写进文件，再动聊天：中途失败也不会丢数据。 */
    if (orphans.size) {
      const restored = await metadataStore.putMany([...orphans.values()]);
      for (const result of restored) rememberResult(result);
    }
    if (attemptsToMove.size) await attemptStore.putMany([...attemptsToMove.values()], { immediate: true });
    await metadataStore.flush();
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
      await metadataStore.flush();
    }

    /* 每个 tagId 一条记录：侧文件里已有的（读聊天时搬进来的、这次会话出过图的）为准，引用按画廊核对，
       超出上限的旧图硬删。当前显示的那一版先算，滑动存档里同一个 tagId 的旧拷贝不覆盖。 */
    const records = new Map();
    let deletedImages = 0;
    const ordered = [
      ...containers.filter(container => container.placement === 'active'),
      ...containers.filter(container => container.placement === 'swipe'),
    ];
    for (const container of ordered) {
      for (const tag of container.metadata.tags) {
        if (!tag?.tagId || records.has(tag.tagId)) continue;
        const existing = store.get(tag.tagId) || legacyRecord(tag);
        let refs = buildResultRefs(existing, tagResultIds(existing), lookup).filter(ref => !dropDangling.has(ref.resultId));
        const victims = selectResultEvictions(refs, lookup);
        if (victims.length) {
          const removed = new Set(await evictResults(victims));
          deletedImages += removed.size;
          refs = refs.filter(ref => !removed.has(ref.resultId));
        }
        const next = { ...existing, promptHash: existing.promptHash || promptHash(tag.prompt), resultRefs: refs };
        next.latestResultId = normalizeLatestResultId(next, lookup);
        records.set(tag.tagId, normalizeTagRecord(next));
      }
    }
    store.putMany([...records.entries()]);
    /* 画廊（删掉的记录）和侧文件都先写完，再动聊天。 */
    await metadataStore.flush();
    await store.flush();

    /* 侧文件写完了，再把楼里的大字段换成引用；最后只保存一次聊天。 */
    const touched = new Set();
    for (const container of containers) {
      const { metadata } = container;
      const tagIds = metadata.tags.map(tag => tag?.tagId).filter(Boolean);
      const ref = { messageUuid: String(metadata.messageUuid || uuid()), tagIds };
      const holder = container.placement === 'active'
        ? container.message.extra
        : container.message.swipe_info[container.swipeId].extra;
      holder.stImageAtelier = ref;
      touched.add(container.message);
    }
    await saveChat([...touched], { immediate: true });
    const after = chatTagsFootprint(chat);
    console.info(`[画笺] 整理后：生图标签数据共 ${after.bytes} 字节，${describeFootprint(after)}`);
    return summary({
      after,
      tags: tagCount,
      legacyTags: legacyTagCount,
      movedAttempts: attemptsToMove.size,
      restoredResults: orphans.size + recovered.length,
      danglingRefs: dangling.size,
      deletedImages,
      droppedRefs: dropDangling.size,
      changed: true,
    });
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
    uploadReferenceImage,
    /* ---------- 参考图组 ---------- */
    getReferenceSets: async () => referenceOverview(),
    /* 新建一组。第一组自动成为默认组；打开着角色卡、它还跟着默认组时，新建的这组直接给它用——换卡建新组就是这个意思。 */
    createReferenceSet: async ({ name = '', bindCurrentCharacter = true } = {}) => {
      const set = normalizeReferenceSet({ name: name || '新参考图组', createdAt: now(), updatedAt: now() });
      namespace.referenceSets.push(set);
      let becameDefault = false;
      let boundCharacter = false;
      if (!namespace.defaultReferenceSetId) {
        namespace.defaultReferenceSetId = set.id;
        becameDefault = true;
      } else if (bindCurrentCharacter) {
        const key = characterKey();
        if (key && boundSetId(key) === null) {
          namespace.referenceBindings[key] = set.id;
          boundCharacter = true;
        }
      }
      await savePreferences({ immediate: true });
      return referenceOverview({ created: { setId: set.id, becameDefault, boundCharacter } });
    },
    renameReferenceSet: async (setId, name) => {
      const set = requireReferenceSet(setId);
      set.name = String(name || '').trim().slice(0, 60) || set.name;
      set.updatedAt = now();
      await savePreferences({ immediate: true });
      return referenceOverview();
    },
    /* 「每张图自动带上」「高保真」跟着组走。 */
    updateReferenceSet: async (setId, patch = {}) => {
      const set = requireReferenceSet(setId);
      if ('useReferences' in patch) set.useReferences = patch.useReferences !== false;
      if ('referenceFidelity' in patch) set.referenceFidelity = patch.referenceFidelity === 'high' ? 'high' : '';
      set.updatedAt = now();
      await savePreferences({ immediate: true });
      return referenceOverview();
    },
    /* 删掉一组：图片文件一起删；用这组的角色改回跟默认；它是默认组时默认换成剩下的第一组。 */
    deleteReferenceSet: async setId => {
      const set = requireReferenceSet(setId);
      namespace.referenceSets = namespace.referenceSets.filter(item => item.id !== setId);
      for (const [key, value] of Object.entries(namespace.referenceBindings)) {
        if (value === setId) delete namespace.referenceBindings[key];
      }
      if (namespace.defaultReferenceSetId === setId) {
        namespace.defaultReferenceSetId = namespace.referenceSets[0]?.id || '';
      }
      await savePreferences({ immediate: true });
      for (const reference of set.references) {
        await removeFile({ localRelativePath: reference.path })
          .catch(error => console.warn('[画笺] 删除参考图文件失败', error));
      }
      return referenceOverview();
    },
    /* 没单独设置的角色用默认组；'' = 默认不带参考图。 */
    setDefaultReferenceSet: async setId => {
      if (setId) requireReferenceSet(setId);
      namespace.defaultReferenceSetId = setId || '';
      await savePreferences({ immediate: true });
      return referenceOverview();
    },
    /* 当前角色出图用哪组：组 id、''（不带参考图）、null（跟默认组）。 */
    bindReferenceSet: async setId => {
      const key = characterKey();
      if (!key) {
        throw new DirectError('VALIDATION_FAILED', '当前没有打开角色卡', 400, false, '当前没有打开角色卡：先打开一个角色卡的聊天，再设置它用哪组参考图');
      }
      if (setId === null || setId === undefined) {
        delete namespace.referenceBindings[key];
      } else {
        if (setId) requireReferenceSet(setId);
        namespace.referenceBindings[key] = setId || '';
      }
      await savePreferences({ immediate: true });
      return referenceOverview();
    },
    /* 给一组加一张参考图：先存进酒馆，再把路径记在组上。 */
    addReference: async (setId, file) => {
      const set = requireReferenceSet(setId);
      if (set.references.length >= MAX_PRESET_REFERENCES) {
        throw new DirectError('VALIDATION_FAILED', `每组最多 ${MAX_PRESET_REFERENCES} 张参考图`, 400, false, `每组最多 ${MAX_PRESET_REFERENCES} 张参考图，先删一张再加`);
      }
      const uploaded = await uploadReferenceImage(file);
      set.references = normalizeReferences([
        ...set.references,
        { id: uploaded.id, path: uploaded.path, name: uploaded.name, addedAt: now() },
      ]);
      set.updatedAt = now();
      await savePreferences({ immediate: true });
      return referenceOverview();
    },
    /* 删掉一张参考图：组里去掉，文件也删（硬删除）。 */
    removeReference: async (setId, referenceId) => {
      const set = requireReferenceSet(setId);
      const target = set.references.find(item => item.id === referenceId);
      if (!target) throw new DirectError('VALIDATION_FAILED', '找不到这张参考图', 400, false, '找不到这张参考图');
      set.references = set.references.filter(item => item.id !== referenceId);
      set.updatedAt = now();
      await savePreferences({ immediate: true });
      await removeFile({ localRelativePath: target.path }).catch(error => console.warn('[画笺] 删除参考图文件失败', error));
      return referenceOverview();
    },
    /* 换一张参考图：原位替换，顺序不变（顺序决定出图时谁排前面），满 4 张也能换，不用先删再加。
       新图传好、设置写盘之后才删旧文件；新图格式不对时原图原样留着。 */
    replaceReference: async (setId, referenceId, file) => {
      const set = requireReferenceSet(setId);
      const index = set.references.findIndex(item => item.id === referenceId);
      if (index < 0) throw new DirectError('VALIDATION_FAILED', '找不到这张参考图', 400, false, '找不到这张参考图');
      const previous = set.references[index];
      const uploaded = await uploadReferenceImage(file);
      const next = [...set.references];
      next[index] = { id: uploaded.id, path: uploaded.path, name: uploaded.name, addedAt: now() };
      set.references = normalizeReferences(next);
      set.updatedAt = now();
      await savePreferences({ immediate: true });
      await removeFile({ localRelativePath: previous.path }).catch(error => console.warn('[画笺] 删除旧参考图文件失败', error));
      return referenceOverview();
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
    thumbnailUrl,
    hasThumbnail: resultId => Boolean(resultIndex.get(resultId)?.thumbnailPath),
    ensureThumbnail,
    backfillThumbnails,
    /* 测试和「等后台做完」用：等所有排着的缩略图任务结束。 */
    thumbnailsSettled: () => Promise.allSettled([...thumbnailRuns, ...thumbnailJobs.values()]),
    organizeChat,
    slimChat: organizeChat,
    reconcileMessage,
    ensureTagStore: () => ensureTagStore(),
    tagRecord: tagId => currentTagStore()?.get(tagId) || null,
    flushPending,
    /* 上次问过之后又认领回了几张图（问完清零）：加载完聊天用来提示一声。 */
    takeAdoptedCount: () => {
      const count = adoptedCount;
      adoptedCount = 0;
      return count;
    },
    chatTagFile: () => chatTagFileName(chatIdentity()),
    /* 一键删除标签后，它的生成记录和侧文件里的记录也一起清掉（硬删除）。 */
    forgetTag: async tagId => {
      await ensureReady();
      await attemptStore.removeForTag(tagId);
      currentTagStore()?.remove(tagId);
    },
  };
}
