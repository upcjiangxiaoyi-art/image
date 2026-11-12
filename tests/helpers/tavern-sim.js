/* 模拟「酒馆服务器 + 一次次打开页面」：同一份聊天文件、用户文件、图片，换一个全新的页面会话就是刷新网页。
   页面一关，它的定时器全停、在途的请求再也回不来——和真的刷新、被 Safari 杀掉一样；没来得及写上服务器的就是丢了。
   真的模块全用上：直连客户端（走酒馆那几套文件接口）、消息事件、状态仓库、自动队列、生图控制器；
   只有卡片渲染是空的，酒馆和别的扩展对楼层 DOM 的改动由 churn() 模拟。 */
import { JSDOM } from 'jsdom';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { createSillyTavernGalleryMetadataStore } from '../../src/ui/api/gallery-metadata-store.js';
import { createSillyTavernAttemptStore } from '../../src/ui/api/attempt-store.js';
import { createSillyTavernChatTagStore } from '../../src/ui/api/chat-tag-store.js';
import { createMessageEvents } from '../../src/ui/events/message-events.js';
import { createStore } from '../../src/ui/state/store.js';
import { createAutoQueue } from '../../src/ui/state/auto-queue.js';
import { createGenerationController } from '../../src/ui/state/generation-controller.js';
import { PNG_BASE64 } from '../mocks/mock-upstream.js';

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeFetch = globalThis.fetch;

export const sleep = ms => new Promise(resolve => nativeSetTimeout(resolve, ms));

/* 酒馆 /api/files/upload 的文件名规则（src/endpoints/assets.js 的 validateAssetFileName）。 */
const TAVERN_FILE_NAME = /^[a-zA-Z0-9_\-.]+$/;
const hang = () => new Promise(() => {});
const json = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export function createTavern({
  chatId = '钟由时 - 2026-11-01@20h59m56s197ms',
  characterKey = 'char:zhong.png',
  chat = [],
} = {}) {
  const tavern = {
    chatId,
    characterKey,
    chatFile: JSON.stringify(chat),
    settingsFile: '{}',
    keys: new Map(),
    files: new Map(),
    images: new Set(),
    upstreamCalls: 0,
    upstreamPrompts: [],
    /* 设成一个 promise 就把上游的回复卡住（请求已经发出去、算过一次钱了）。 */
    upstreamGate: null,
    chatSaves: 0,
    fileWrites: [],
    rejectedFileNames: [],
    /* 用户文件上传要这么久才到服务器；页面在这之前没了，这次写就丢了。 */
    fileUploadLatencyMs: 0,
    /* 名字以这些开头的用户文件一律写失败（HTTP 500）。 */
    failFilePrefixes: [],
    current: null,
  };

  tavern.fetch = async (url, options = {}) => {
    const owner = tavern.current;
    const dead = () => !owner || owner.dead;
    if (dead()) return hang();
    const target = String(url);
    if (target === '/api/files/upload') {
      const body = JSON.parse(options.body);
      if (tavern.fileUploadLatencyMs) {
        await sleep(tavern.fileUploadLatencyMs);
        if (dead()) return hang();
      }
      if (!TAVERN_FILE_NAME.test(body.name)) {
        tavern.rejectedFileNames.push(body.name);
        return new Response("Illegal character in filename; only alphanumeric, '_', '-' are accepted.", { status: 400 });
      }
      if (tavern.failFilePrefixes.some(prefix => body.name.startsWith(prefix))) {
        return new Response('', { status: 500 });
      }
      tavern.files.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
      tavern.fileWrites.push(body.name);
      return json(200, { path: `user/files/${body.name}` });
    }
    if (target.startsWith('/user/files/')) {
      const name = decodeURIComponent(target.slice('/user/files/'.length).split('?')[0]);
      return tavern.files.has(name)
        ? new Response(tavern.files.get(name), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('Not Found', { status: 404 });
    }
    if (target === '/api/images/upload') {
      const body = JSON.parse(options.body);
      const path = `user/images/${body.ch_name}/${body.filename}.${body.format}`;
      tavern.images.add(path);
      return json(200, { path });
    }
    if (target === '/api/images/delete') {
      tavern.images.delete(JSON.parse(options.body).path);
      return json(200, {});
    }
    if (target.startsWith('/user/images/')) {
      const path = target.slice(1).split('?')[0];
      return tavern.images.has(path)
        ? new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200, headers: { 'Content-Type': 'image/png' } })
        : new Response('Not Found', { status: 404 });
    }
    if (target.endsWith('/v1/images/generations')) {
      tavern.upstreamCalls += 1;
      tavern.upstreamPrompts.push(JSON.parse(options.body).prompt);
      if (tavern.upstreamGate) await tavern.upstreamGate;
      if (dead()) return hang();
      return json(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    throw new Error(`意外的请求：${options.method || 'GET'} ${target}`);
  };
  globalThis.fetch = tavern.fetch;

  tavern.dispose = () => {
    tavern.current?.close();
    globalThis.fetch = nativeFetch;
  };
  tavern.fileNames = prefix => [...tavern.files.keys()].filter(name => name.startsWith(prefix));
  tavern.readFile = name => JSON.parse(tavern.files.get(name));
  tavern.writeFile = (name, value) => tavern.files.set(name, JSON.stringify(value));
  tavern.readChat = () => JSON.parse(tavern.chatFile);
  return tavern;
}

/* 打开一次页面。flushDelayMs：各个文件延后合并写的时间（默认压到 20ms，测试跑得快）；
   传 'production' 用线上的 1.5～2 秒，测「图刚画好就刷新」。 */
export async function openPage(tavern, { flushDelayMs = 20 } = {}) {
  if (tavern.current) throw new Error('上一个页面还开着：先 close() 再 openPage()');
  /* 让上一个页面剩下的微任务跑完（它们发的请求会落在「没有页面」上，再也回不来）。 */
  await sleep(5);
  const timers = new Set();
  const page = { dead: false, errors: [], problems: [], tavern };
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = nativeSetTimeout(callback, delay, ...args);
    timers.add(handle);
    return handle;
  };
  globalThis.setInterval = (callback, delay, ...args) => {
    const handle = nativeSetInterval(callback, delay, ...args);
    timers.add(handle);
    return handle;
  };
  const dom = new JSDOM('<!DOCTYPE html><div id="chat"></div>', { url: 'http://localhost' });
  const previousGlobals = {};
  for (const key of ['window', 'document', 'Node', 'MutationObserver', 'HTMLElement', 'Element']) {
    previousGlobals[key] = globalThis[key];
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  tavern.current = page;

  const chat = tavern.readChat();
  const extensionSettings = JSON.parse(tavern.settingsFile);
  const handlers = new Map();
  let streamingId = -1;
  const persistChat = async () => {
    tavern.chatFile = JSON.stringify(chat);
    tavern.chatSaves += 1;
  };
  const compat = {
    chat: () => chat,
    currentChatId: () => tavern.chatId,
    currentCharacterKey: () => tavern.characterKey,
    currentCharacterName: () => '钟由时',
    save: persistChat,
    saveSoon: persistChat,
    isStreaming: messageId => Number(messageId) === streamingId,
    headers: () => ({ 'Content-Type': 'application/json' }),
    on: (names, handler) => {
      for (const name of names) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(handler);
      }
      return names;
    },
    messageElement: id => dom.window.document.querySelector(`#chat .mes[mesid="${id}"]`),
  };
  const saveSettings = () => { tavern.settingsFile = JSON.stringify(extensionSettings); };
  const storeOptions = flushDelayMs === 'production' ? {} : { flushDelayMs };
  const api = createDirectApiClient({
    compat,
    extensionSettings,
    saveSettingsDebounced: saveSettings,
    saveSettingsNow: saveSettings,
    keyStorage: {
      getItem: key => tavern.keys.get(key) ?? null,
      setItem: (key, value) => tavern.keys.set(key, value),
      removeItem: key => tavern.keys.delete(key),
    },
    galleryStore: createSillyTavernGalleryMetadataStore(compat, tavern.fetch, storeOptions),
    attemptStore: createSillyTavernAttemptStore(compat, tavern.fetch, storeOptions),
    chatTagStore: identity => createSillyTavernChatTagStore(compat, identity, tavern.fetch, storeOptions),
    thumbnailer: null,
  });
  const store = createStore();
  const controller = createGenerationController({
    api,
    store,
    compat,
    onProblem: context => page.problems.push(context),
    onError: error => page.errors.push(error),
  });
  const autoQueue = createAutoQueue(controller.generate);
  const renderer = { mount: () => ({ mounted: 0, fallback: 0 }), removeCard() {} };
  const events = createMessageEvents({
    compat,
    api,
    store,
    renderer,
    autoQueue,
    onError: error => page.errors.push(error),
  });

  const { document } = dom.window;
  const chatElement = document.querySelector('#chat');
  function renderRow(index) {
    let row = chatElement.querySelector(`.mes[mesid="${index}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'mes';
      row.setAttribute('mesid', String(index));
      row.innerHTML = '<div class="mes_block"><div class="mes_text"></div></div><div class="mes_buttons"></div>';
      chatElement.append(row);
    }
    row.querySelector('.mes_text').textContent = chat[index].mes;
  }

  Object.assign(page, {
    dom,
    chat,
    api,
    store,
    controller,
    events,
    compat,
    emit: (name, ...args) => Promise.all((handlers.get(name) || []).map(handler => handler(...args))),
    settle: (ms = 260) => sleep(ms),
    async waitFor(predicate, { timeout = 5000, label = '条件' } = {}) {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error(`等不到：${label}`);
        await sleep(10);
      }
    },
    /* 配好预设、开关自动生图（存进扩展设置，刷新后还在）。 */
    async configure({ autoGenerate = true } = {}) {
      await api.updateSettings({ autoGenerate });
      await api.updatePreset({ baseUrl: 'https://upstream.test', apiKey: 'sk-test', selectedModel: 'gpt-image-1' });
      const data = await api.getPresets();
      store.set({
        settings: await api.getSettings(),
        preset: data.items.find(item => item.id === data.activePresetId) || data.items[0],
      });
    },
    /* 酒馆收到一条新回复：进聊天、存聊天、画出来、发事件。 */
    async receive(mes, generationType = 'normal') {
      chat.push({ is_user: false, name: '钟由时', mes, extra: {} });
      const index = chat.length - 1;
      await persistChat();
      renderRow(index);
      await page.emit('MESSAGE_RECEIVED', index, generationType);
      await page.emit('CHARACTER_MESSAGE_RENDERED', index);
      return index;
    },
    /* 改某一楼的正文（IPE 事后把 <draw> 贴进去、手动编辑）：改内存、存聊天、酒馆重画这一楼。 */
    async rewrite(index, mes, { event = 'MESSAGE_EDITED' } = {}) {
      chat[index].mes = mes;
      await persistChat();
      if (event) await page.emit(event, index);
      renderRow(index);
    },
    /* 页面加载后楼层 DOM 的各种变动：酒馆重发渲染事件、别的扩展（IPE）给每一楼挂按钮、酒馆重画正文。 */
    async churn() {
      for (let index = 0; index < chat.length; index += 1) {
        await page.emit('CHARACTER_MESSAGE_RENDERED', index);
        const button = document.createElement('span');
        button.className = 'ipe-mes-btn';
        chatElement.querySelector(`.mes[mesid="${index}"] .mes_buttons`).append(button);
      }
      await sleep(240);
      for (let index = 0; index < chat.length; index += 1) {
        const text = chatElement.querySelector(`.mes[mesid="${index}"] .mes_text`);
        text.textContent = '';
        text.textContent = chat[index].mes;
      }
      await sleep(280);
    },
    tagIds(index) {
      const metadata = chat[index]?.extra?.stImageAtelier;
      if (Array.isArray(metadata?.tagIds)) return [...metadata.tagIds];
      return (metadata?.tags || []).map(tag => tag.tagId);
    },
    state: tagId => store.state.tagStates.get(tagId),
    /* 卡片上点「生成」。 */
    async generateManually(index, ordinal = 0) {
      const { tags, messageUuid } = await api.reconcileMessage(index);
      return controller.generate({ ...tags[ordinal], messageUuid, chatId: tavern.chatId }, 'manual');
    },
    /* 页面没了：刷新、关掉、被系统杀掉。 */
    close() {
      if (page.dead) return;
      page.dead = true;
      for (const handle of timers) clearTimeout(handle);
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.setInterval = nativeSetInterval;
      dom.window.close();
      for (const [key, value] of Object.entries(previousGlobals)) globalThis[key] = value;
      tavern.current = null;
    },
  });

  chat.forEach((_, index) => renderRow(index));
  const [settings, presets] = [await api.getSettings(), await api.getPresets()];
  store.set({ settings, preset: presets.items.find(item => item.id === presets.activePresetId) || presets.items[0] });
  events.bind();
  /* index.js 的 initialize() 先 hydrate 一次，酒馆载入聊天后再发 CHAT_CHANGED。 */
  await events.hydrate();
  await page.emit('CHAT_CHANGED');
  await sleep(120);
  return page;
}
