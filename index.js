import {
  eventSource,
  event_types,
  getRequestHeaders,
  saveChatConditional,
  saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { createStCompat } from './src/ui/compat/st-api.js';
import { createApiClient } from './src/ui/api/client.js';
import { createStore } from './src/ui/state/store.js';
import { createAutoQueue } from './src/ui/state/auto-queue.js';
import { createMessageRenderer } from './src/ui/renderer/message-renderer.js';
import { createMessageEvents } from './src/ui/events/message-events.js';
import { createToolPanel } from './src/ui/pages/settings/settings.js';
import { installToolMenuEntry } from './src/ui/menu/tool-menu.js';
import { applyThemeMode } from './src/ui/theme/theme.js';
import { removeDrawTagFromMessage } from './src/ui/state/tag-removal.js';
import { createPromptOverrideDialog } from './src/ui/pages/prompt-override/prompt-override.js';
import { createErrorDialog, createProblemReporter } from './src/ui/pages/error-dialog/error-dialog.js';
import { createGenerationController } from './src/ui/state/generation-controller.js';

const compat = createStCompat({
  getContext,
  eventSource,
  eventTypes: event_types,
  saveChatConditional,
  getRequestHeaders,
});
const api = createApiClient({
  compat,
  extensionSettings: extension_settings,
  saveSettingsDebounced,
  keyStorage: accountStorage,
});
const store = createStore();
let errorDialog;
const { reportProblem, reportError } = createProblemReporter({ store, getDialog: () => errorDialog });
let reportedServiceError = null;
store.subscribe(state => {
  document.documentElement.classList.toggle('stia-disabled', !state.settings.enabled);
  applyThemeMode(state.settings.themeMode);
  /* 连不上服务端插件、读不到聊天里的生图数据等，只在出现新的错误时弹一次。 */
  if (state.serviceError && state.serviceError !== reportedServiceError) {
    reportedServiceError = state.serviceError;
    reportError(state.serviceError, '画笺服务出错');
  }
});
applyThemeMode(store.state.settings.themeMode);
const GALLERY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function runGalleryCleanup() {
  try {
    return await api.cleanupGallery();
  } catch (error) {
    console.warn('[画笺] 画廊自动清理检查失败', error);
    return null;
  }
}

const controller = createGenerationController({
  api,
  store,
  compat,
  onProblem: reportProblem,
  onSucceeded: () => void runGalleryCleanup(),
  onError: reportError,
});
const { generate } = controller;

const autoQueue = createAutoQueue(generate);
let panel;
let promptOverrideDialog;
const actions = {
  generate,
  adjustRegenerate: async (tag, context = {}) => {
    const provider = store.state.settings.generationProvider || 'openai';
    const value = await promptOverrideDialog.open({
      prompt: context.prompt || tag.prompt,
      negativePrompt: provider === 'novelai'
        ? (context.negativePrompt || store.state.novelAi?.negativePrompt || '')
        : '',
      provider,
    });
    if (!value) return null;
    return generate(tag, 'manual', {
      prompt: value.prompt,
      ...(provider === 'novelai' ? { negativePromptOverride: value.negativePrompt } : {}),
    });
  },
  cancel: attemptId => controller.cancel(attemptId),
  openGallery: () => panel.show('gallery'),
  remove: async tag => removeTag(tag),
};
const renderer = createMessageRenderer({ compat, api, store, actions });
const events = createMessageEvents({ compat, api, store, renderer, autoQueue, onError: reportError });

/* 一键删除：卡片 + 消息里的 <draw> 注入词 + 标签元数据一起清掉，落盘后不留痕迹。 */
async function removeTag(tag) {
  if (controller.isActive(tag.tagId)) return false;
  const chat = compat.chat();
  const messageId = chat.findIndex(message => {
    const metadata = message?.extra?.stImageAtelier;
    if (!metadata) return false;
    if (tag.messageUuid && metadata.messageUuid === tag.messageUuid) return true;
    return (metadata.tags || []).some(item => item?.tagId === tag.tagId);
  });
  if (messageId < 0) {
    renderer.removeCard(tag.tagId);
    store.removeTag(tag.tagId);
    return false;
  }
  const { changed } = removeDrawTagFromMessage(chat[messageId], tag.tagId);
  renderer.removeCard(tag.tagId);
  store.removeTag(tag.tagId);
  if (!changed) return false;
  try {
    await compat.save();
  } catch (error) {
    console.error('[画笺] 删除生图标签后无法保存聊天', error);
    reportError(error, '删除后保存聊天失败');
  }
  await events.processMessage(messageId, { live: false });
  return true;
}

function installToolButton() {
  installToolMenuEntry({
    root: document,
    onOpen: () => panel.show(),
  });
}

function initialize() {
  errorDialog = createErrorDialog();
  panel = createToolPanel({ api, store, onError: reportError });
  promptOverrideDialog = createPromptOverrideDialog();
  installToolButton();
  events.bind();
  void events.hydrate().catch(error => {
    console.error('[画笺] 加载聊天里的生图卡片失败', error);
    reportError(error, '加载聊天里的生图卡片失败');
  });
  void runGalleryCleanup();
  setInterval(() => void runGalleryCleanup(), GALLERY_CLEANUP_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}
