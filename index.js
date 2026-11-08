import {
  eventSource,
  event_types,
  getRequestHeaders,
  saveChatConditional,
  saveSettingsDebounced,
} from '../../../../script.js';
import * as tavern from '../../../../script.js';
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
import { metadataTagIds } from './src/ui/state/tag-identity.js';
import { describeBytes } from './src/ui/state/tag-footprint.js';
import { createPromptOverrideDialog } from './src/ui/pages/prompt-override/prompt-override.js';
import { createErrorDialog, createProblemReporter } from './src/ui/pages/error-dialog/error-dialog.js';
import { createGenerationController } from './src/ui/state/generation-controller.js';
import { openImageViewer } from './src/ui/media/image-viewer.js';

const compat = createStCompat({
  getContext,
  eventSource,
  eventTypes: event_types,
  saveChatConditional,
  /* 酒馆的防抖保存（改楼、滑动走的就是它）：插件的保存并进同一个防抖，同一秒只写一次盘。老酒馆没有就退回自己防抖。 */
  saveChatDebounced: typeof tavern.saveChatDebounced === 'function' ? tavern.saveChatDebounced : undefined,
  getRequestHeaders,
});
const api = createApiClient({
  compat,
  extensionSettings: extension_settings,
  saveSettingsDebounced,
  /* 参考图增删这类不能丢的改动当场写盘；老酒馆没有 saveSettings 就退回防抖。 */
  saveSettingsNow: typeof tavern.saveSettings === 'function' ? tavern.saveSettings : undefined,
  keyStorage: accountStorage,
});
const store = createStore();
let errorDialog;
const { reportProblem, reportError } = createProblemReporter({
  store,
  getDialog: () => errorDialog,
  /* 重 roll、滑走后才画好的图，卡片已经不在眼前，从提醒里直接打开原图。 */
  viewResult: (resultId, attempt) => {
    const prompt = attempt?.promptSnapshot || attempt?.resolvedPrompt || '';
    openImageViewer({
      src: api.fileUrl(resultId),
      alt: prompt.slice(0, 120),
      filename: resultId,
      prompt,
      meta: attempt?.model || '',
    });
  },
});
let reportedServiceError = null;
store.subscribe((state, change) => {
  try {
    if (change?.tagId) return;
    document.documentElement.classList.toggle('stia-disabled', !state.settings.enabled);
    applyThemeMode(state.settings.themeMode);
    /* 连不上服务端插件、读不到聊天里的生图数据等，只在出现新的错误时弹一次。 */
    if (state.serviceError && state.serviceError !== reportedServiceError) {
      reportedServiceError = state.serviceError;
      reportError(state.serviceError, '画笺服务出错');
    }
  } catch (error) {
    console.warn('[画笺] 更新页面状态失败', error);
  }
});
applyThemeMode(store.state.settings.themeMode);
const GALLERY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/* 出图后的自动清理检查往后挪几秒：那一瞬间酒馆要存聊天、要画图，别再挤一件事进去。 */
const GALLERY_CLEANUP_AFTER_RESULT_MS = 3000;

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
  onSucceeded: () => { setTimeout(() => void runGalleryCleanup(), GALLERY_CLEANUP_AFTER_RESULT_MS); },
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
  /* 等不及时「再画一张」（可换预设），正在画的那张留在后台接着画。 */
  reroll: (tag, attemptId, preset) => controller.reroll(tag, attemptId, preset),
  /* 「参考重画」：拿卡片上这张图（或相册选的）当参考再画，人脸、服装跟着它。 */
  referenceRegenerate: (tag, { references, preset } = {}) => generate(tag, 'manual', {
    references,
    ...(preset ? { preset } : {}),
  }),
  /* 失败的卡片上「换备用线路」：用设置里的备用线路重画。 */
  fallback: tag => controller.generateWithBackup(tag),
  cancel: attemptId => controller.cancel(attemptId),
  openGallery: () => panel.show('gallery'),
  remove: async tag => removeTag(tag),
};
const renderer = createMessageRenderer({ compat, api, store, actions });

/* 2.0.0：打开聊天后如果还有旧格式的楼（整份标签数据写在聊天里），提醒一次去整理。手机上看不到控制台，
   用酒馆的 toastr；每个聊天每次会话只说一遍。只算账，不动任何数据。 */
const legacyNoticed = new Set();
async function noticeLegacyChat() {
  try {
    const chatId = compat.currentChatId();
    if (!chatId || legacyNoticed.has(chatId) || typeof api.organizeChat !== 'function') return;
    const plan = await api.organizeChat({ dryRun: true });
    if (!plan?.containers) return;
    legacyNoticed.add(chatId);
    const text = `这个聊天还有 ${plan.legacyFloors} 楼旧格式的生图数据（${describeBytes(plan.before.bytes)}）。`
      + '到「画笺 → 设置 → 整理旧数据」一次搬完，聊天文件会小很多；整理前建议先用小锚快照或导出一份。';
    if (typeof globalThis.toastr?.info === 'function') globalThis.toastr.info(text, '画笺', { timeOut: 12000 });
    else console.info(`[画笺] ${text}`);
  } catch (error) {
    console.warn('[画笺] 检查旧格式生图数据失败', error);
  }
}

const events = createMessageEvents({
  compat,
  api,
  store,
  renderer,
  autoQueue,
  onError: reportError,
  onHydrated: () => void noticeLegacyChat(),
});

/* 一键删除：卡片 + 消息里的 <draw> 注入词 + 标签元数据一起清掉，落盘后不留痕迹。 */
async function removeTag(tag) {
  if (controller.isActive(tag.tagId)) return false;
  const chat = compat.chat();
  const messageId = chat.findIndex(message => {
    const metadata = message?.extra?.stImageAtelier;
    if (!metadata) return false;
    if (metadataTagIds(metadata).includes(tag.tagId)) return true;
    return Boolean(tag.messageUuid) && metadata.messageUuid === tag.messageUuid;
  });
  if (messageId < 0) {
    renderer.removeCard(tag.tagId);
    store.removeTag(tag.tagId);
    return false;
  }
  const { changed } = removeDrawTagFromMessage(chat[messageId], tag.tagId, { prompt: tag.prompt });
  renderer.removeCard(tag.tagId);
  store.removeTag(tag.tagId);
  if (!changed) return false;
  /* 它的生成记录在独立存储里，一起清掉（硬删除）。 */
  void Promise.resolve(api.forgetTag?.(tag.tagId)).catch(error => {
    console.warn('[画笺] 清理生图标签的生成记录失败', error);
  });
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
