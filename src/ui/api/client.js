import { API_ROOT } from '../../shared/constants.js';
import { createDirectApiClient } from './direct-client.js';
import { chatScope, findMessageForRecord } from '../state/chat-scope.js';

export class ApiError extends Error {
  constructor(error, status) {
    super(error?.message || '服务端请求失败');
    this.code = error?.code || 'SERVER_PLUGIN_UNAVAILABLE';
    this.retryable = Boolean(error?.retryable);
    this.details = error?.details;
    this.status = status;
  }
}

export function createServerApiClient(compat) {
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        credentials: 'same-origin',
        ...options,
        headers: {
          ...compat.headers({ json: options.body != null }),
          ...(options.headers || {}),
        },
      });
    } catch {
      throw new ApiError({
        code: 'SERVER_PLUGIN_UNAVAILABLE',
        message: '服务端插件不可用，请确认已启用 Server Plugins 并重启 SillyTavern',
      }, 503);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new ApiError(payload?.error || {
        code: 'SERVER_PLUGIN_UNAVAILABLE',
        message: `服务端返回异常（HTTP ${response.status}）`,
      }, response.status);
    }
    return payload.data;
  }

  const json = value => JSON.stringify(value);
  return {
    health: () => request('/health'),
    getSettings: () => request('/settings'),
    updateSettings: patch => request('/settings', { method: 'PATCH', body: json(patch) }),
    getPresets: () => request('/presets'),
    updatePreset: (presetId, patch) => request(`/presets/${encodeURIComponent(presetId)}`, {
      method: 'PATCH',
      body: json(patch),
    }),
    clearSecret: presetId => request(`/presets/${encodeURIComponent(presetId)}/clear-secret`, {
      method: 'POST',
      body: '{}',
    }),
    listModels: presetId => request(`/presets/${encodeURIComponent(presetId)}/models`, {
      method: 'POST',
      body: '{}',
    }),
    testPreset: presetId => request(`/presets/${encodeURIComponent(presetId)}/test`, {
      method: 'POST',
      body: '{}',
    }),
    resolveTags: tagIds => request('/tags/resolve', { method: 'POST', body: json({ tagIds }) }),
    generate: input => request('/generate', { method: 'POST', body: json(input) }),
    attempt: attemptId => request(`/attempts/${encodeURIComponent(attemptId)}`),
    cancel: attemptId => request(`/attempts/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST', body: '{}' }),
    gallery: ({ cursor, limit = 30 } = {}) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      return request(`/gallery?${query}`);
    },
    galleryMetadata: () => request('/gallery-metadata'),
    cleanupGallery: () => request('/gallery/cleanup', { method: 'POST', body: '{}' }),
    deleteResult: resultId => request(`/gallery/${encodeURIComponent(resultId)}`, { method: 'DELETE' }),
    setFavorite: (resultId, favorite) => request(`/gallery/${encodeURIComponent(resultId)}`, {
      method: 'PATCH',
      body: json({ favorite }),
    }),
    fileUrl: resultId => `${API_ROOT}/gallery/${encodeURIComponent(resultId)}/file`,
    downloadUrl: resultId => `${API_ROOT}/gallery/${encodeURIComponent(resultId)}/download`,
  };
}

export function createApiClient({
  compat,
  extensionSettings,
  saveSettingsDebounced,
  saveSettingsNow,
  keyStorage,
}) {
  const direct = createDirectApiClient({
    compat,
    extensionSettings,
    saveSettingsDebounced,
    saveSettingsNow,
    keyStorage,
  });
  const server = createServerApiClient(compat);
  const selected = () => direct.mode() === 'server' ? server : direct;

  async function getSettings() {
    const local = await direct.getSettings();
    if (direct.mode() !== 'server') return local;
    const remote = await server.getSettings();
    return {
      ...remote,
      executionMode: 'server',
      generationProvider: local.generationProvider,
      themeMode: local.themeMode,
      enableErrorPopup: local.enableErrorPopup,
      backupPresetId: local.backupPresetId,
      enableAutoFallback: local.enableAutoFallback,
    };
  }

  async function updateSettings(patch) {
    const requestedMode = patch.executionMode || direct.mode();
    const local = await direct.updateSettings({ ...patch, executionMode: requestedMode });
    if (requestedMode === 'direct') return local;
    const remotePatch = { ...patch };
    delete remotePatch.executionMode;
    delete remotePatch.generationProvider;
    delete remotePatch.themeMode;
    /* 报错弹窗、备用线路是浏览器这一端的偏好，和主题一样只存本地。 */
    delete remotePatch.enableErrorPopup;
    delete remotePatch.backupPresetId;
    delete remotePatch.enableAutoFallback;
    const remote = Object.keys(remotePatch).length
      ? await server.updateSettings(remotePatch)
      : await server.getSettings();
    return {
      ...remote,
      executionMode: 'server',
      generationProvider: local.generationProvider,
      themeMode: local.themeMode,
      enableErrorPopup: local.enableErrorPopup,
      backupPresetId: local.backupPresetId,
      enableAutoFallback: local.enableAutoFallback,
    };
  }

  return {
    health: () => selected().health(),
    getSettings,
    updateSettings,
    getPresets: () => selected().getPresets(),
    getNovelAi: () => direct.getNovelAi(),
    updateNovelAi: patch => direct.updateNovelAi(patch),
    clearNovelAiSecret: () => direct.clearNovelAiSecret(),
    selectArtistPreset: presetId => direct.selectArtistPreset(presetId),
    createArtistPreset: input => direct.createArtistPreset(input),
    updateArtistPreset: (presetId, patch) => direct.updateArtistPreset(presetId, patch),
    exportArtistPresets: options => direct.exportArtistPresets(options),
    importArtistPresets: payload => direct.importArtistPresets(payload),
    deleteArtistPreset: presetId => direct.deleteArtistPreset(presetId),
    selectPreset: presetId => direct.mode() === 'direct'
      ? direct.selectPreset(presetId)
      : server.getPresets().then(data => data.items.find(item => item.id === presetId)),
    createPreset: input => {
      if (direct.mode() !== 'direct') {
        throw new ApiError({ message: '多 API 预设目前用于免服务端直连模式' }, 400);
      }
      return direct.createPreset(input);
    },
    updatePreset: (presetId, patch) => selected().updatePreset(presetId, patch),
    deletePreset: presetId => {
      if (direct.mode() !== 'direct') {
        throw new ApiError({ message: '多 API 预设目前用于免服务端直连模式' }, 400);
      }
      return direct.deletePreset(presetId);
    },
    clearSecret: presetId => selected().clearSecret(presetId),
    listModels: presetId => selected().listModels(presetId),
    testPreset: presetId => selected().testPreset(presetId),
    resolveTags: (tagIds, options) => selected().resolveTags(tagIds, options),
    /* 参考图组（图生图）：组是全局的、按角色卡记，和 API 预设无关；出图带参考图目前只有免服务端直连的 GPT 有。 */
    uploadReferenceImage: file => direct.uploadReferenceImage(file),
    getReferenceSets: () => direct.getReferenceSets(),
    createReferenceSet: input => direct.createReferenceSet(input),
    renameReferenceSet: (setId, name) => direct.renameReferenceSet(setId, name),
    updateReferenceSet: (setId, patch) => direct.updateReferenceSet(setId, patch),
    deleteReferenceSet: setId => direct.deleteReferenceSet(setId),
    setDefaultReferenceSet: setId => direct.setDefaultReferenceSet(setId),
    bindReferenceSet: setId => direct.bindReferenceSet(setId),
    addReference: (setId, file) => {
      if (direct.mode() !== 'direct') {
        throw new ApiError({ message: '参考图目前用于免服务端直连模式' }, 400);
      }
      return direct.addReference(setId, file);
    },
    removeReference: (setId, referenceId) => direct.removeReference(setId, referenceId),
    replaceReference: (setId, referenceId, file) => {
      if (direct.mode() !== 'direct') {
        throw new ApiError({ message: '参考图目前用于免服务端直连模式' }, 400);
      }
      return direct.replaceReference(setId, referenceId, file);
    },
    generate: input => {
      if (input.provider === 'novelai') return direct.generate(input);
      if (direct.mode() === 'server' && input.references?.length) {
        throw new ApiError({ message: '增强模式暂不支持参考图' }, 400);
      }
      return selected().generate(input);
    },
    attempt: attemptId => selected().attempt(attemptId),
    cancel: attemptId => selected().cancel(attemptId),
    gallery: options => selected().gallery(options),
    galleryMetadata: () => selected().galleryMetadata(),
    cleanupGallery: () => selected().cleanupGallery(),
    deleteResult: resultId => selected().deleteResult(resultId),
    setFavorite: (resultId, favorite) => selected().setFavorite(resultId, favorite),
    fileUrl: resultId => direct.hasResult(resultId)
      ? direct.fileUrl(resultId)
      : server.fileUrl(resultId),
    downloadUrl: resultId => direct.hasResult(resultId)
      ? direct.downloadUrl(resultId)
      : server.downloadUrl(resultId),
    /* 画廊格子用缩略图；只有直连的画廊有，增强模式的画廊在服务端，格子里仍是原图。 */
    thumbnailUrl: resultId => direct.hasResult(resultId)
      ? direct.thumbnailUrl(resultId)
      : server.fileUrl(resultId),
    ensureThumbnail: resultId => (direct.hasResult(resultId)
      ? direct.ensureThumbnail(resultId)
      : Promise.resolve(null)),
    backfillThumbnails: options => direct.backfillThumbnails(options),
    /* 聊天瘦身和标签的生成记录清理都只关乎聊天文件和浏览器这一端的独立存储，增强模式下也走直连这份。 */
    organizeChat: options => direct.organizeChat(options),
    slimChat: options => direct.organizeChat(options),
    forgetTag: tagId => direct.forgetTag(tagId),
    reconcileMessage: messageId => direct.reconcileMessage(messageId),
    ensureTagStore: () => direct.ensureTagStore(),
    tagRecord: tagId => direct.tagRecord(tagId),
    flushPending: () => direct.flushPending(),
    storageStatus: () => direct.storageStatus(),
    /* 画廊「只看这个聊天」：当前聊天用到的 messageUuid / tagId 和聊天名。 */
    chatScope: () => chatScope(compat.chat(), compat.currentChatId()),
    /* 画廊「跳到所在楼层」：在当前聊天里找这张图所在的楼，滚过去。
       找不到是 not-in-chat（那一楼删了、重新生成过，或者图是别的聊天的）；找到了但酒馆画不出来是 not-rendered。 */
    jumpToResult: async record => {
      const found = findMessageForRecord(compat.chat(), record);
      if (!found) return { ok: false, reason: 'not-in-chat' };
      const ok = typeof compat.jumpToMessage === 'function' ? await compat.jumpToMessage(found.messageId) : false;
      return ok ? { ok: true, ...found } : { ok: false, reason: 'not-rendered', ...found };
    },
    takeAdoptedCount: () => direct.takeAdoptedCount(),
    chatTagFile: () => direct.chatTagFile(),
    mode: () => direct.mode(),
  };
}
