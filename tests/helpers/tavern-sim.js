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

/* 酒馆用 res.sendFile 发用户文件，ETag 是 W/"大小-修改时间"。这里按内容算，效果一样：内容变了 ETag 就变。 */
function etagOf(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
  return `W/"${Buffer.byteLength(text).toString(16)}-${hash.toString(16)}"`;
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

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
    /* 每次用户文件上传：{ name, bytes（文件本身多大）, bodyBytes（请求体多大，base64 之后） }。 */
    uploads: [],
    /* 每次读用户文件：{ name, method, status, bytes（回了多少正文） }。 */
    fileReads: [],
    fileDeletes: [],
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
      const content = Buffer.from(body.data, 'base64');
      tavern.files.set(body.name, content.toString('utf8'));
      tavern.fileWrites.push(body.name);
      tavern.uploads.push({ name: body.name, bytes: content.length, bodyBytes: Buffer.byteLength(options.body) });
      return json(200, { path: `user/files/${body.name}` });
    }
    if (target === '/api/files/verify') {
      const urls = JSON.parse(options.body).urls;
      return json(200, Object.fromEntries(urls.map(item => [item, tavern.files.has(item.replace(/^user\/files\//, ''))])));
    }
    if (target === '/api/files/delete') {
      const name = String(JSON.parse(options.body).path || '').replace(/^user\/files\//, '');
      if (!tavern.files.has(name)) return new Response('File not found', { status: 404 });
      tavern.files.delete(name);
      tavern.fileDeletes.push(name);
      return new Response('OK', { status: 200 });
    }
    if (target.startsWith('/user/files/')) {
      const name = decodeURIComponent(target.slice('/user/files/'.length).split('?')[0]);
      const method = options.method || 'GET';
      const log = (status, bytes = 0) => tavern.fileReads.push({ name, method, status, bytes });
      if (!tavern.files.has(name)) {
        log(404);
        return new Response('Not Found', { status: 404 });
      }
      const text = tavern.files.get(name);
      const etag = etagOf(text);
      if (method === 'HEAD') {
        log(200);
        return new Response(null, { status: 200, headers: { ETag: etag } });
      }
      /* express（fresh 模块）见到请求里有 Cache-Control: no-cache 就不比 ETag、直接回整份。浏览器会给
         cache: 'no-store' 的请求自动补上这个头，除非请求自己带了 Cache-Control——所以没带的一律当成有 no-cache。 */
      const cacheControl = headerOf(options.headers, 'Cache-Control');
      const forcedReload = cacheControl === null || /(?:^|,)\s*no-cache\s*(?:,|$)/.test(cacheControl);
      if (!forcedReload && headerOf(options.headers, 'If-None-Match') === etag) {
        log(304);
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      log(200, Buffer.byteLength(text));
      return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag } });
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
  /* 服务器上现在算数的画廊记录 / 生成记录：有清单就按清单把各个分片合起来，没有就是旧的整份文件。
     kind：'gallery'（记录在 results 里）或 'attempts'（在 attempts 里）。 */
  const layout = kind => ({
    manifest: `st-image-atelier-${kind}-index.json`,
    segment: id => `st-image-atelier-${kind}-${id}.json`,
    legacy: `st-image-atelier-${kind}.json`,
    key: kind === 'gallery' ? 'results' : 'attempts',
  });
  tavern.segmentFiles = kind => {
    const { manifest, segment } = layout(kind);
    if (!tavern.files.has(manifest)) return [];
    return tavern.readFile(manifest).segments.map(segment).filter(name => tavern.files.has(name));
  };
  tavern.records = kind => {
    const { manifest, legacy, key } = layout(kind);
    if (!tavern.files.has(manifest)) {
      return tavern.files.has(legacy) ? Object.values(tavern.readFile(legacy)[key] || {}) : [];
    }
    return tavern.segmentFiles(kind).flatMap(name => Object.values(tavern.readFile(name)[key] || {}));
  };
  /* 把服务器上的这类记录全清空（模拟被上限清掉、文件丢了）。 */
  tavern.clearRecords = kind => {
    const { legacy, key } = layout(kind);
    for (const name of [...tavern.segmentFiles(kind), ...(tavern.files.has(legacy) ? [legacy] : [])]) {
      tavern.writeFile(name, { ...tavern.readFile(name), [key]: {} });
    }
  };
  tavern.readChat = () => JSON.parse(tavern.chatFile);
  return tavern;
}

/* 打开一次页面。flushDelayMs：各个文件延后合并写的时间（默认压到 20ms，测试跑得快）；
   传 'production' 用线上的 1.5～2 秒，测「图刚画好就刷新」。
   thumbnailer：画廊缩略图用的假实现（默认不做缩略图）；thumbnailDelayMs：出图后多久做。 */
export async function openPage(tavern, { flushDelayMs = 20, thumbnailer = null, thumbnailDelayMs } = {}) {
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
    thumbnailer,
    ...(thumbnailDelayMs === undefined ? {} : { thumbnailDelayMs }),
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
