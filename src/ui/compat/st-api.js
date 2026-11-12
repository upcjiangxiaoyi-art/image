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
    /* 酒馆的「加载更早的楼层」（script.js 的 showMoreMessages）；老酒馆没有就去点那个按钮。 */
    showMoreMessages,
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

  /* 参考图组按角色卡记：群聊按群 id，单人按头像文件名（角色列表重排也不变）。没开聊天为空。 */
  function currentCharacterKey() {
    const current = context();
    if (!current) return '';
    if (current.groupId) return `group:${current.groupId}`;
    const character = current.characters?.[current.characterId];
    if (character?.avatar) return `char:${character.avatar}`;
    return current.characterId == null ? '' : `char-index:${current.characterId}`;
  }

  function currentCharacterName() {
    const current = context();
    if (!current) return '';
    if (current.groupId) return String(current.groups?.find(group => group.id === current.groupId)?.name || '群聊');
    return String(current.characters?.[current.characterId]?.name || '');
  }

  function messageElement(messageId) {
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(String(messageId))}"]`);
  }

  /* 滚到某一楼并闪一下。酒馆只把最近的一部分楼层画在页面上：目标楼还没画出来，就先让酒馆一批批把更早的
     加载出来（和酒馆自己的 loadUntilMesId 一个做法），到头了还没有再试 /chat-jump。成功返回 true。 */
  async function jumpToMessage(messageId, { maxBatches = 80 } = {}) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) return false;
    const firstRendered = () => Number(document.querySelector('#chat .mes[mesid]')?.getAttribute('mesid'));
    let element = messageElement(id);
    for (let batch = 0; !element && batch < maxBatches; batch += 1) {
      const before = firstRendered();
      /* 最早画出来的那一楼已经不比目标晚：再往前加载也没用。 */
      if (!(before > id)) break;
      if (typeof showMoreMessages === 'function') {
        await showMoreMessages();
      } else {
        const more = document.querySelector('#show_more_messages');
        if (!more) break;
        more.click();
        await new Promise(resolve => setTimer(resolve, 80));
      }
      element = messageElement(id);
      if (!element && firstRendered() === before) break;
    }
    if (!element) {
      const current = context();
      const run = current?.executeSlashCommandsWithOptions || current?.executeSlashCommands;
      if (typeof run === 'function') {
        try {
          await run.call(current, `/chat-jump ${id}`);
        } catch {
          /* 这个酒馆没有这条命令。 */
        }
        element = messageElement(id);
      }
    }
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    element.classList.add('stia-jump-highlight');
    setTimer(() => element.classList.remove('stia-jump-highlight'), 2600);
    return true;
  }

  return {
    context,
    chat,
    currentChatId,
    currentCharacterKey,
    currentCharacterName,
    save,
    saveSoon,
    headers,
    event,
    on,
    isStreaming,
    messageElement,
    jumpToMessage,
  };
}
