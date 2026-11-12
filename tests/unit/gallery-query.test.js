import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  filterGalleryItems,
  galleryFilterOptions,
  normalizeGalleryItem,
} from '../../src/ui/pages/gallery/gallery-query.js';
import { createGalleryPage, galleryBadges } from '../../src/ui/pages/gallery/gallery.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

function item(overrides = {}) {
  return {
    resultId: overrides.resultId || crypto.randomUUID(),
    status: 'available',
    createdAt: '2026-09-07T08:00:00.000Z',
    prompt: 'cat in sunlight',
    apiModel: 'gpt-image-1',
    presetId: 'main',
    presetNameSnapshot: '主站 API',
    provider: 'openai',
    favorite: false,
    ...overrides,
  };
}

test('旧画廊数据迁移为单份提示词并补齐收藏默认值', () => {
  const normalized = normalizeGalleryItem({
    resultId: 'old',
    prompt: 'legacy prompt',
    presetId: 'novelai',
  });
  assert.equal(normalized.favorite, false);
  assert.equal(normalized.prompt, 'legacy prompt');
  assert.equal('promptSnapshot' in normalized, false);
  assert.equal(normalized.provider, 'novelai');
});

test('搜索和多个筛选条件组合生效，缺字段与空结果不报错', () => {
  const values = [
    item({ resultId: 'cat', favorite: true }),
    item({
      resultId: 'nai',
      prompt: '1girl, moon',
      apiModel: 'nai-diffusion-4-5-full',
      provider: 'novelai',
      presetId: 'novelai',
      artistPresetId: 'soft',
      artistPresetNameSnapshot: '柔光画师串',
      artistPromptSnapshot: 'artist:sample, watercolor',
      favorite: true,
    }),
    item({
      resultId: 'old',
      prompt: 'old cat',
      createdAt: '2026-08-01T00:00:00.000Z',
    }),
    { resultId: 'missing-fields', status: 'available' },
  ];
  assert.deepEqual(filterGalleryItems(values, {
    query: 'WATERCOLOR',
    favorite: 'favorite',
    provider: 'novelai',
    model: 'nai-diffusion-4-5-full',
    source: 'artist:soft',
    date: '7d',
  }, NOW).map(value => value.resultId), ['nai']);
  assert.deepEqual(filterGalleryItems(values, { query: 'not-found' }, NOW), []);
  const options = galleryFilterOptions(values);
  assert.ok(options.models.includes('gpt-image-1'));
  assert.ok(options.sources.some(value => value.label === '画师串：柔光画师串'));
  assert.ok(options.sources.some(value => value.label === 'API 预设：主站 API'));
});

test('批量收藏、取消收藏和删除只作用于当前筛选后选中的项目', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://tavern.example/',
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    confirm: globalThis.confirm,
  };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.confirm = () => true;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    globalThis.confirm = previous.confirm;
    dom.window.close();
  });

  const values = [
    item({ resultId: 'cat-1', prompt: 'cat one' }),
    item({ resultId: 'cat-2', prompt: 'cat two' }),
    item({ resultId: 'dog', prompt: 'dog' }),
  ];
  const favoriteCalls = [];
  const deleteCalls = [];
  const api = {
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => ({ items: structuredClone(values), total: values.length }),
    fileUrl: id => `/images/${id}.png`,
    downloadUrl: id => `/download/${id}`,
    setFavorite: async (id, favorite) => {
      favoriteCalls.push([id, favorite]);
      return { ...values.find(value => value.resultId === id), favorite };
    },
    deleteResult: async id => { deleteCalls.push(id); },
  };
  const page = createGalleryPage(api);
  document.body.append(page.root);
  await page.load();

  const buttons = () => [...page.root.querySelectorAll('button')];
  const click = label => buttons().find(value => value.textContent === label).click();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const search = page.root.querySelector('input[type="search"]');
  search.value = 'cat';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 150));
  click('批量选择');
  const firstCatImage = page.root.querySelector('[data-result-id="cat-1"] img');
  firstCatImage.click();
  assert.equal(buttons().some(value => value.textContent === '已选择 1 张'), true);
  assert.equal(page.root.querySelector('[data-result-id="cat-1"] input[type="checkbox"]').checked, true);
  firstCatImage.click();
  assert.equal(buttons().some(value => value.textContent === '已选择 0 张'), true);
  click('选择当前结果');
  click('批量收藏');
  await settle();
  assert.deepEqual(favoriteCalls, [['cat-1', true], ['cat-2', true]]);

  click('选择当前结果');
  click('取消收藏');
  await settle();
  assert.deepEqual(favoriteCalls.slice(2), [['cat-1', false], ['cat-2', false]]);

  click('选择当前结果');
  click('批量删除');
  await settle();
  assert.deepEqual(deleteCalls, ['cat-1', 'cat-2']);
  assert.equal(deleteCalls.includes('dog'), false);
});

test('画廊卡片标出渠道和画质：GPT 显示预设名和画质，NovelAI 显示画师串，老记录没记画质就不标', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tavern.example/' });
  const previous = { document: globalThis.document, window: globalThis.window, navigator: globalThis.navigator };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    dom.window.close();
  });

  const values = [
    item({ resultId: 'gpt-new', presetNameSnapshot: '稳定组', qualitySnapshot: 'max', requestedSize: '1024x1536', createdAt: '2026-09-07T09:00:00.000Z' }),
    item({ resultId: 'gpt-default', presetNameSnapshot: '主站 API', qualitySnapshot: '', createdAt: '2026-09-07T08:30:00.000Z' }),
    item({ resultId: 'gpt-dropped', presetNameSnapshot: '主站 API', qualitySnapshot: 'xhigh', compatibilityRetry: { adjustedParameters: ['quality'] }, createdAt: '2026-09-07T08:15:00.000Z' }),
    item({ resultId: 'gpt-old', presetNameSnapshot: '主站 API', createdAt: '2026-09-07T08:00:00.000Z' }),
    item({ resultId: 'gpt-bare', presetNameSnapshot: '', presetId: '', createdAt: '2026-09-07T07:30:00.000Z' }),
    item({
      resultId: 'nai', provider: 'novelai', presetId: 'novelai', apiModel: 'nai-diffusion-4-5-full',
      artistPresetId: 'soft', artistPresetNameSnapshot: '柔光画师串', createdAt: '2026-09-07T07:00:00.000Z',
    }),
  ];
  const api = {
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => ({ items: structuredClone(values), total: values.length }),
    fileUrl: id => `/images/${id}.png`,
    downloadUrl: id => `/download/${id}`,
    setFavorite: async () => ({}),
    deleteResult: async () => {},
  };
  const page = createGalleryPage(api);
  document.body.append(page.root);
  await page.load();
  const badgesOf = id => [...page.root.querySelectorAll(`[data-result-id="${id}"] .stia-gallery-card__badge`)]
    .map(element => element.textContent);
  assert.deepEqual(badgesOf('gpt-new'), ['GPT · 稳定组', 'max']);
  assert.deepEqual(badgesOf('gpt-default'), ['GPT · 主站 API', '默认'], '没发 quality 的标「默认」');
  assert.deepEqual(badgesOf('gpt-dropped'), ['GPT · 主站 API', '默认（xhigh 被拒）'], '智能重试去掉过画质的照卡片的说法');
  assert.deepEqual(badgesOf('gpt-old'), ['GPT · 主站 API'], '1.7.0 之前的记录没记画质，不标');
  assert.deepEqual(badgesOf('gpt-bare'), ['GPT'], '连预设名都没记的只标引擎');
  assert.deepEqual(badgesOf('nai'), ['NAI · 柔光画师串'], 'NovelAI 标画师串，没有画质');
  assert.ok(page.root.querySelector('[data-result-id="nai"] .stia-gallery-card__badge').classList.contains('is-novelai'));
  assert.ok(page.root.querySelector('[data-result-id="gpt-new"] .stia-gallery-card__badge.is-quality'));
  assert.equal(page.root.querySelector('[data-result-id="gpt-new"] .stia-gallery-card__badges').nextElementSibling.tagName, 'STRONG', '小标在模型名上面');

  const search = page.root.querySelector('input[type="search"]');
  search.value = 'max';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual([...page.root.querySelectorAll('.stia-gallery-card')].map(card => card.dataset.resultId), ['gpt-new'], '搜索也认画质');

  const { info, badges } = galleryBadges(values[0]);
  assert.equal(info.size, '1024×1536', '原图查看层的信息行顺带带上尺寸');
  assert.deepEqual(badges.map(badge => badge.kind), ['openai', 'quality']);
});

test('画廊格子用缩略图；没有的先放原图、后台补好后换成小图；只给缺的那张补', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tavern.example/' });
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const values = [
      item({ resultId: 'with-thumb', thumbnailPath: 'user/images/st-image-atelier-thumbs/with-thumb-thumb.jpeg' }),
      item({ resultId: 'no-thumb' }),
    ];
    const ensured = [];
    const api = {
      cleanupGallery: async () => ({}),
      galleryMetadata: async () => ({ items: structuredClone(values), total: values.length }),
      fileUrl: id => `/images/${id}.png`,
      downloadUrl: id => `/download/${id}`,
      thumbnailUrl: id => (values.find(value => value.resultId === id)?.thumbnailPath ? `/thumbs/${id}.jpeg` : `/images/${id}.png`),
      ensureThumbnail: async id => {
        ensured.push(id);
        const path = `user/images/st-image-atelier-thumbs/${id}-thumb.jpeg`;
        values.find(value => value.resultId === id).thumbnailPath = path;
        return path;
      },
      setFavorite: async () => ({}),
      deleteResult: async () => {},
    };
    const page = createGalleryPage(api);
    document.body.append(page.root);
    await page.load();
    const src = id => page.root.querySelector(`[data-result-id="${id}"] img`).getAttribute('src');
    assert.equal(src('with-thumb'), '/thumbs/with-thumb.jpeg', '有缩略图的格子用缩略图');
    assert.equal(src('no-thumb'), '/images/no-thumb.png', '没有的先放原图');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(ensured, ['no-thumb'], '只给没有缩略图的那张补');
    assert.equal(src('no-thumb'), '/thumbs/no-thumb.jpeg', '补好后格子换成小图');
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});

test('filterGalleryItems：scope 只留当前聊天的图，和搜索、别的筛选叠加', async () => {
  const { chatScope } = await import('../../src/ui/state/chat-scope.js');
  const scope = chatScope([{ extra: { stImageAtelier: { messageUuid: 'm1', tagIds: ['t1'] } } }], '这个聊天');
  const values = [
    item({ resultId: 'here-by-tag', tagId: 't1', chatId: '改名前', prompt: 'cat' }),
    item({ resultId: 'here-by-name', tagId: 'x', chatId: '这个聊天', prompt: 'dog' }),
    item({ resultId: 'elsewhere', tagId: 'y', chatId: '别的聊天', prompt: 'cat' }),
  ];
  assert.deepEqual(filterGalleryItems(values, { scope }, NOW).map(value => value.resultId).sort(), ['here-by-name', 'here-by-tag']);
  assert.deepEqual(filterGalleryItems(values, { scope, query: 'cat' }, NOW).map(value => value.resultId), ['here-by-tag']);
  assert.equal(filterGalleryItems(values, {}, NOW).length, 3, '不给 scope 就是全部');
});

test('画廊「只看这个聊天」和看图器里的「跳到所在楼层」', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tavern.example/' });
  const previous = { document: globalThis.document, window: globalThis.window, navigator: globalThis.navigator };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  try {
    const { chatScope } = await import('../../src/ui/state/chat-scope.js');
    const values = [
      item({ resultId: 'here', tagId: 't1', messageUuid: 'm1', chatId: '这个聊天', prompt: 'cat here' }),
      item({ resultId: 'other', tagId: 't9', messageUuid: 'm9', chatId: '别的聊天', prompt: 'cat elsewhere' }),
    ];
    let scope = chatScope([{ extra: { stImageAtelier: { messageUuid: 'm1', tagIds: ['t1'] } } }], '这个聊天');
    const jumps = [];
    let outcome = { ok: true, messageId: 12, placement: 'active' };
    const navigated = [];
    const api = {
      cleanupGallery: async () => ({}),
      galleryMetadata: async () => ({ items: structuredClone(values), total: values.length }),
      fileUrl: id => `/images/${id}.png`,
      downloadUrl: id => `/download/${id}`,
      chatScope: () => scope,
      jumpToResult: async record => { jumps.push(record.resultId); return outcome; },
      setFavorite: async () => ({}),
      deleteResult: async () => {},
    };
    const page = createGalleryPage(api, { onNavigate: value => navigated.push(value) });
    document.body.append(page.root);
    await page.load();
    const ids = () => [...page.root.querySelectorAll('[data-result-id]')].map(node => node.dataset.resultId);
    const toggle = [...page.root.querySelectorAll('button')].find(node => node.textContent.includes('只看这个聊天'));
    assert.deepEqual(ids().sort(), ['here', 'other'], '默认是全部聊天的图');
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');

    toggle.click();
    assert.deepEqual(ids(), ['here'], '只剩这个聊天的图');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.match(page.root.textContent, /1 \/ 2 张/);

    /* 这个聊天的图：看图器里有「跳到所在楼层」。 */
    page.root.querySelector('[data-result-id="here"] img').click();
    const viewer = () => document.querySelector('.stia-image-viewer');
    const jump = () => [...(viewer()?.querySelectorAll('button') || [])].find(node => node.textContent === '跳到所在楼层');
    assert.ok(jump(), '有跳转按钮');
    jump().click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(jumps, ['here']);
    assert.deepEqual(navigated, [outcome], '告诉面板该关了');
    assert.equal(viewer(), null, '跳过去之后看图器关掉');

    /* 那一楼已经不在了：留在看图器里把原因写出来。 */
    outcome = { ok: false, reason: 'not-in-chat' };
    page.root.querySelector('[data-result-id="here"] img').click();
    jump().click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(viewer().textContent, /找不到这张图所在的楼层/);
    assert.equal(navigated.length, 1);
    viewer().querySelector('.stia-image-viewer__close').click();

    /* 别的聊天的图：没有跳转按钮，写明是哪个聊天里画的。 */
    toggle.click();
    assert.deepEqual(ids().sort(), ['here', 'other']);
    page.root.querySelector('[data-result-id="other"] img').click();
    assert.equal(jump(), undefined, '不是这个聊天的图不给跳');
    assert.match(viewer().textContent, /画于聊天「别的聊天」/);
    viewer().querySelector('.stia-image-viewer__close').click();

    /* 没打开聊天：开关用不了，也不会卡在「只看这个聊天」上。 */
    toggle.click();
    scope = chatScope([], '');
    await page.load();
    assert.equal(toggle.disabled, true);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(ids().sort(), ['here', 'other']);
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
  }
});
