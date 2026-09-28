export function createStCompat(dependencies) {
  const {
    getContext,
    eventSource,
    eventTypes,
    saveChatConditional,
    getRequestHeaders,
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

  async function save() {
    if (typeof saveChatConditional === 'function') return saveChatConditional();
    const current = context();
    if (typeof current?.saveChat === 'function') return current.saveChat();
    if (typeof current?.saveMetadata === 'function') return current.saveMetadata();
    throw new Error('当前 SillyTavern 未提供聊天保存方法');
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
    headers,
    event,
    on,
    isStreaming,
    messageElement,
  };
}
