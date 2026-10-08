import { parseDrawTags, shouldProcessMessage } from '../parser/draw-parser.js';
import { reconcileTagMetadata } from '../state/tag-identity.js';
import { warnIfHeavy } from '../state/tag-footprint.js';

const DOM_SETTLE_MS = 140;
const SOURCE_SCAN_INTERVAL_MS = 1_500;

export function hasChangedDrawSource(message, previousSource) {
  return shouldProcessMessage(message)
    && message.mes !== previousSource
    && /<draw\b/i.test(message.mes);
}

export function createMessageEvents({ compat, api, store, renderer, autoQueue, onError = () => {} }) {
  const sourceCache = new Map();
  const scheduled = new Map();
  let observer = null;
  let observedChat = null;
  let pollTimer = null;
  let hydrated = false;
  let cachedChatId = '';

  function reportFailure(title) {
    return error => {
      console.error(`[画笺] ${title}`, error);
      onError(error, title);
    };
  }

  async function processMessage(messageId, { live = false, generationType = '' } = {}) {
    const message = compat.chat()[Number(messageId)];
    if (!shouldProcessMessage(message)) return;
    sourceCache.set(String(messageId), message.mes);
    const parsed = parseDrawTags(message.mes);
    if (!parsed.length) return;

    const { metadata, changed } = reconcileTagMetadata(message, parsed);
    if (changed) {
      /* 写入前检查：这一楼的标签数据超过 20 KB 就在控制台警告并列出各字段大小。 */
      warnIfHeavy(message, messageId);
      try {
        /* 延后合并保存：正文写完那一瞬间酒馆自己紧跟着就会整份保存（新标签的 ID 已经写进内存里的
           message.extra，会一起带上），这里再当场存一次就是同一秒两份几十 MB 的序列化。 */
        await (typeof compat.saveSoon === 'function' ? compat.saveSoon() : compat.save());
      } catch (error) {
        console.error('[画笺] 无法保存标签元数据', error);
        onError(error, '保存生图标签数据失败');
      }
    }

    const tags = metadata.tags.map((tag, index) => ({
      ...parsed[index],
      ...tag,
      messageUuid: metadata.messageUuid,
      chatId: compat.currentChatId(),
    }));
    renderer.mount(messageId, tags);
    try {
      const resolved = await api.resolveTags(tags.map(tag => tag.tagId));
      for (const value of resolved) store.applyResolvedTag(value.tagId, value);
    } catch (error) {
      store.set({ serviceError: error });
    }
    renderer.mount(messageId, tags);

    /* 还在流式输出时只挂卡片、不排队：写完后标签可能变（被停、被重 roll、正则改写），
       早排的队会变成失效标签或白花一张图。等 MESSAGE_RECEIVED 拿到定稿再排。 */
    const eligibleLiveMessage = store.state.settings.enabled
      && live
      && generationType !== 'first_message'
      && store.state.settings.autoGenerate
      && !compat.isStreaming?.(messageId);
    if (eligibleLiveMessage) {
      for (const tag of tags.slice(0, 3)) {
        const current = store.state.tagStates.get(tag.tagId);
        if (!current?.tag?.autoAttempted && !current?.tag?.autoSuppressed && !tag.autoSuppressed) {
          autoQueue.enqueue(tag);
        }
      }
    }
  }

  async function hydrate() {
    hydrated = false;
    cachedChatId = compat.currentChatId();
    sourceCache.clear();
    const chat = compat.chat();
    const ids = chat.map((_, index) => index);
    for (const messageId of ids) {
      await processMessage(messageId, { live: false });
    }
    hydrated = true;
  }

  function scheduleMessage(messageId, options = {}) {
    const id = String(messageId ?? '');
    if (!/^\d+$/.test(id)) return;
    const previous = scheduled.get(id);
    clearTimeout(previous?.timer);
    const mergedOptions = {
      ...previous?.options,
      ...options,
      live: Boolean(previous?.options?.live || options.live),
    };
    const timer = setTimeout(() => {
      scheduled.delete(id);
      void processMessage(id, mergedOptions).catch(reportFailure('识别生图标签失败'));
    }, DOM_SETTLE_MS);
    scheduled.set(id, { timer, options: mergedOptions });
  }

  function messageIdFromNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest?.('#chat .mes[mesid]')?.getAttribute('mesid') ?? null;
  }

  function observeChat() {
    const chatElement = document.querySelector('#chat');
    if (!chatElement || chatElement === observedChat) return;
    observer?.disconnect();
    observedChat = chatElement;
    observer = new MutationObserver(records => {
      const ids = new Set();
      for (const record of records) {
        const targetElement = record.target?.nodeType === Node.ELEMENT_NODE
          ? record.target
          : record.target?.parentElement;
        if (targetElement?.closest?.('.stia-card')) continue;
        const id = messageIdFromNode(record.target);
        if (id != null) ids.add(id);
        for (const node of record.addedNodes || []) {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches?.('.stia-card, .stia-card-list')) {
            continue;
          }
          const addedId = messageIdFromNode(node);
          if (addedId != null) ids.add(addedId);
        }
      }
      for (const id of ids) scheduleMessage(id, { live: hydrated });
    });
    observer.observe(chatElement, { childList: true, characterData: true, subtree: true });
  }

  function scanChangedSources() {
    if (!hydrated) return;
    const chatId = compat.currentChatId();
    if (chatId !== cachedChatId) {
      cachedChatId = chatId;
      void hydrate().catch(reportFailure('加载聊天里的生图卡片失败'));
      return;
    }
    compat.chat().forEach((message, messageId) => {
      if (!shouldProcessMessage(message)) return;
      const id = String(messageId);
      const previousSource = sourceCache.get(id);
      if (previousSource === message.mes) return;
      sourceCache.set(id, message.mes);
      if (hasChangedDrawSource(message, previousSource)) {
        scheduleMessage(id, { live: true });
      }
    });
  }

  function bind() {
    compat.on(['MESSAGE_RECEIVED'], (messageId, generationType) =>
      processMessage(messageId, { live: true, generationType })
        .catch(reportFailure('识别生图标签失败')));
    /* 画完一楼的事件紧跟在 MESSAGE_RECEIVED 后面，同一楼刚处理过；走防抖和 DOM 监听合成一次，
       别在流式结束那一瞬间连做三遍。 */
    compat.on(['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RENDERED'], messageId =>
      scheduleMessage(messageId, { live: false }));
    /* 改写事件会赶在酒馆用 mes 重建这一层 DOM 之前到达。直接 processMessage 等于对着
       旧 DOM 干活：卡片还在、提示词还没回来，mount 判定无事可做直接退出；等重建真的发生，
       事件已经消耗掉了。改走 scheduleMessage，等 DOM_SETTLE_MS 落定后再处理，
       与 MutationObserver 走同一条路，并合并成一次。 */
    compat.on(['MESSAGE_UPDATED', 'MESSAGE_EDITED'], messageId =>
      scheduleMessage(messageId, { live: false }));
    compat.on(['CHAT_CHANGED'], () => {
      queueMicrotask(() => {
        observeChat();
        void hydrate().catch(reportFailure('加载聊天里的生图卡片失败'));
      });
    });
    observeChat();
    if (!pollTimer) {
      pollTimer = setInterval(scanChangedSources, SOURCE_SCAN_INTERVAL_MS);
      pollTimer.unref?.();
    }
  }

  return { processMessage, hydrate, bind };
}
