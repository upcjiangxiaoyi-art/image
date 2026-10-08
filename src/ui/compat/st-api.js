export function createStCompat(dependencies) {
  const {
    getContext,
    eventSource,
    eventTypes,
    saveChatConditional,
    saveChatDebounced,
    getRequestHeaders,
    saveDelayMs = 1000,
    setTimer = (callback, delay) => setTimeout(callback, delay),
  } = dependencies;

  function context() {
    return typeof getContext === 'function'
      ? getContext()
      : globalThis.SillyTavern?.getContext?.();
  }

  function chat() {
    return context()?.chat || [];
  }

  function currentChatId() {
    const value = context()?.chatId
      ?? context()?.getCurrentChatId?.()
      ?? context()?.characterId
      ?? context()?.groupId;
    return value == null ? '' : String(value);
  }

  /* 当场整份保存聊天（酒馆的 saveChatConditional，自带互斥：同一时刻只有一次保存在途）。 */
  async function save() {
    if (typeof saveChatConditional === 'function') return saveChatConditional();
    const current = context();
    if (typeof current?.saveChat === 'function') return current.saveChat();
    if (typeof current?.saveMetadata === 'function') return current.saveMetadata();
    throw new Error('当前 SillyTavern 未提供聊天保存方法');
  }

  /* 延后、合并的保存。酒馆自己改楼、滑动、删楼走的就是 saveChatDebounced（1 秒防抖，整份聊天只写一次）：
     并进同一个防抖，同一秒里不管酒馆还是插件要存都只写一次盘，也错开了流式结束、出图返回那一瞬间的高峰——
     那一刻酒馆自己要存、要重画，插件再叠一份几十 MB 的序列化，手机上就白屏。酒馆没有这个函数时自己拖 1 秒
     再 save，期间再叫几次也只存一次。 */
  let pendingSave = null;
  function saveSoon() {
    const debounced = typeof saveChatDebounced === 'function'
      ? saveChatDebounced
      : context()?.saveChatDebounced;
    if (typeof debounced === 'function') {
      debounced();
      return Promise.resolve();
    }
    if (!pendingSave) {
      pendingSave = setTimer(() => {
        pendingSave = null;
        save().catch(error => console.warn('[画笺] 延后保存聊天失败', error));
      }, saveDelayMs);
    }
    return Promise.resolve();
  }

  function headers({ json = true } = {}) {
    if (typeof getRequestHeaders === 'function') {
      return getRequestHeaders({ omitContentType: !json });
    }
    const token = context()?.token || globalThis.SillyTavern?.token;
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-CSRF-Token': token } : {}),
    };
  }

  function event(...names) {
    for (const name of names) {
      if (eventTypes?.[name]) return eventTypes[name];
    }
    return null;
  }

  function on(names, handler) {
    const selected = [...new Set(names.map(name => eventTypes?.[name]).filter(Boolean))];
    if (eventSource?.on) {
      for (const eventName of selected) eventSource.on(eventName, handler);
    }
    return selected;
  }

  /* 酒馆还在流式输出这一层时正文随时会变：可能被停止、重 roll，写完后还会过一遍正则脚本、
     去掉行尾空格。自动生图要等它写完（MESSAGE_RECEIVED 时 isFinished 已为 true）。
     messageId 还是 -1 说明新内容尚未开始写，此时正在准备的是最后一层。 */
  function isStreaming(messageId) {
    const processor = context()?.streamingProcessor;
    if (!processor || processor.isFinished || processor.isStopped) return false;
    const streamingId = Number(processor.messageId);
    const target = Number(messageId);
    return streamingId >= 0 ? streamingId === target : target === chat().length - 1;
  }

  function messageElement(messageId) {
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(String(messageId))}"]`);
  }

  return {
    context,
    chat,
    currentChatId,
    save,
    saveSoon,
    headers,
    event,
    on,
    isStreaming,
    messageElement,
  };
}
