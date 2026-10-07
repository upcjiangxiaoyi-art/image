import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RESULTS_PER_TAG,
  buildResultRefs,
  canonicalTag,
  hasLegacyFields,
  hydrateAttempt,
  leanTag,
  normalizeLatestResultId,
  rebuildInPlace,
  selectResultEvictions,
  slimAttempt,
  tagResultIds,
  writeTagResults,
} from '../../src/ui/state/tag-storage.js';
import { byteLength } from '../../src/ui/state/tag-footprint.js';

const records = new Map([
  ['r-1', { resultId: 'r-1', localRelativePath: 'user/images/st-image-atelier/r-1.png', createdAt: '2026-10-01T00:00:01.000Z', favorite: false }],
  ['r-2', { resultId: 'r-2', localRelativePath: 'user/images/st-image-atelier/r-2.png', createdAt: '2026-10-01T00:00:02.000Z', favorite: true }],
  ['r-3', { resultId: 'r-3', localRelativePath: 'user/images/st-image-atelier/r-3.png', createdAt: '2026-10-01T00:00:03.000Z', favorite: false }],
]);
const lookup = resultId => records.get(resultId) || null;

test('生成记录精简：去掉提示词的复制品，和标签一样的基础提示词不存，读出来再补回去', () => {
  const prompt = '雨夜霓虹街道中的电影感人像'.repeat(40);
  const attempt = {
    attemptId: 'a',
    tagId: 't',
    status: 'failed',
    promptSnapshot: prompt,
    resolvedPrompt: `artist, ${prompt}, best quality`,
    resolvedNegativePrompt: 'lowres',
    artistPromptSnapshot: 'artist:a, artist:b'.repeat(100),
    artistNegativePromptSnapshot: 'bad anatomy'.repeat(100),
    artistPresetNameSnapshot: '柔光画师串',
    negativePromptSnapshot: 'bad hands',
    errorMessage: 'x'.repeat(1000),
    statusMessage: 'y'.repeat(500),
    parameters: { size: '1024x1024' },
  };
  const slim = slimAttempt(attempt, prompt);
  assert.equal('promptSnapshot' in slim, false, '和标签一样的提示词不再存一份');
  for (const key of ['resolvedPrompt', 'resolvedNegativePrompt', 'artistPromptSnapshot', 'artistNegativePromptSnapshot']) {
    assert.equal(key in slim, false, `${key} 不存`);
  }
  assert.equal(slim.artistPresetNameSnapshot, '柔光画师串', '画师串的名字留着');
  assert.equal(slim.negativePromptSnapshot, 'bad hands');
  assert.equal(slim.errorMessage.length, 401, '报错截到 400 字加省略号');
  assert.equal(slim.statusMessage.length, 200);
  assert.ok(byteLength(slim) < 1024, `精简后不到 1 KB：${byteLength(slim)}`);
  assert.equal(attempt.resolvedPrompt.length > 0, true, '不改原对象');

  const override = slimAttempt({ ...attempt, promptSnapshot: '临时改过的提示词' }, prompt);
  assert.equal(override.promptSnapshot, '临时改过的提示词', '调整后重绘的临时提示词要留');
  assert.equal(hydrateAttempt(slim, prompt).promptSnapshot, prompt, '读出来补回标签的提示词');
  assert.equal(hydrateAttempt(override, prompt).promptSnapshot, '临时改过的提示词');
  assert.equal(hydrateAttempt(null, prompt), null);
});

test('标签字段顺序固定；原地改写保持对象引用', () => {
  const tag = { autoSuppressed: false, resultRefs: [], prompt: 'p', tagId: 't', latestResultId: null, autoAttempted: true, ratio: undefined, unknown: 1 };
  const canonical = canonicalTag(tag);
  assert.deepEqual(Object.keys(canonical), ['tagId', 'prompt', 'latestResultId', 'resultRefs', 'autoAttempted', 'autoSuppressed']);
  assert.equal('unknown' in canonical, false, '不认识的字段不带');
  const same = rebuildInPlace(tag, canonical);
  assert.equal(same, tag);
  assert.deepEqual(Object.keys(tag), Object.keys(canonical));
  assert.equal(hasLegacyFields(tag), false);
  assert.equal(hasLegacyFields({ attempts: [] }), true);
  assert.equal(hasLegacyFields({ resultIds: [] }), true);
  assert.equal(hasLegacyFields({ results: [] }), true);
});

test('图片引用：有记录的从记录取路径，带路径的旧引用照留，旧版只有 id 又没记录的丢掉', () => {
  const tag = {
    tagId: 't',
    prompt: 'p',
    resultRefs: [
      { resultId: 'r-1', path: 'stale/path.png', createdAt: '2020-01-01T00:00:00.000Z' },
      { resultId: 'gone', path: 'user/images/st-image-atelier/gone.png', createdAt: '2026-10-01T00:00:09.000Z' },
    ],
  };
  const refs = buildResultRefs(tag, ['r-1', 'gone', 'r-3', 'unknown', 'r-1'], lookup);
  assert.deepEqual(refs, [
    { resultId: 'r-1', path: 'user/images/st-image-atelier/r-1.png', createdAt: '2026-10-01T00:00:01.000Z' },
    { resultId: 'gone', path: 'user/images/st-image-atelier/gone.png', createdAt: '2026-10-01T00:00:09.000Z' },
    { resultId: 'r-3', path: 'user/images/st-image-atelier/r-3.png', createdAt: '2026-10-01T00:00:03.000Z' },
  ]);
  assert.deepEqual(tagResultIds(tag), ['r-1', 'gone']);
  assert.deepEqual(tagResultIds({ resultIds: ['a', 'a', 'b'] }), ['a', 'b'], '旧版的 resultIds 也认');
  assert.deepEqual(tagResultIds({}), []);
});

test('writeTagResults 原地换成精简形：旧版字段去掉，空的 attempts 也去掉，有内容的 attempts 等搬走', () => {
  const legacy = {
    tagId: 't', prompt: 'p', ordinal: 0, count: 1, latestResultId: 'r-1',
    resultIds: ['r-1'], attempts: [], results: [{ resultId: 'r-1' }], autoAttempted: false, autoSuppressed: false,
  };
  const same = writeTagResults(legacy, ['r-1', 'r-2'], lookup);
  assert.equal(same, legacy);
  assert.deepEqual(Object.keys(legacy), ['tagId', 'prompt', 'ordinal', 'count', 'latestResultId', 'resultRefs', 'autoAttempted', 'autoSuppressed']);
  assert.deepEqual(legacy.resultRefs.map(ref => ref.resultId), ['r-1', 'r-2']);

  const pending = { tagId: 't', prompt: 'p', resultIds: [], attempts: [{ attemptId: 'a' }] };
  writeTagResults(pending, [], lookup);
  assert.deepEqual(pending.attempts, [{ attemptId: 'a' }], '还没搬走的生成记录先留着');
  assert.equal('resultIds' in pending, false);
});

test('leanTag 给出瘦身后的标签；latestResultId 只指向卡片上能显示的那张', () => {
  const legacy = {
    tagId: 't', prompt: 'p', ordinal: 2, ratio: 'portrait', count: 1,
    latestResultId: 'gone',
    resultIds: ['r-1', 'gone', 'r-2'],
    attempts: [{ attemptId: 'a', promptSnapshot: 'p' }],
    results: [{ resultId: 'r-1' }],
    resultRefs: undefined,
    autoAttempted: 1,
  };
  const lean = leanTag(legacy, lookup);
  assert.deepEqual(lean, {
    tagId: 't',
    prompt: 'p',
    ordinal: 2,
    ratio: 'portrait',
    count: 1,
    latestResultId: 'r-2',
    resultRefs: [
      { resultId: 'r-1', path: 'user/images/st-image-atelier/r-1.png', createdAt: '2026-10-01T00:00:01.000Z' },
      { resultId: 'r-2', path: 'user/images/st-image-atelier/r-2.png', createdAt: '2026-10-01T00:00:02.000Z' },
    ],
    autoAttempted: true,
    autoSuppressed: false,
  });
  const dangling = { tagId: 't', prompt: 'p', latestResultId: 'gone', resultRefs: [{ resultId: 'gone', path: 'x.png', createdAt: '' }, { resultId: 'r-1', path: '', createdAt: '' }] };
  assert.equal(normalizeLatestResultId(dangling, lookup), 'r-1');
  assert.deepEqual(leanTag(dangling, lookup, { dropDangling: new Set(['gone']) }).resultRefs.map(ref => ref.resultId), ['r-1'], '确认文件不在的引用丢掉');
  assert.deepEqual(leanTag(dangling, lookup).resultRefs.map(ref => ref.resultId), ['gone', 'r-1'], '没确认的留着');
});

test('超过每张卡上限时先删空引用，再删最早没收藏的；刚画好的和收藏的不动', () => {
  assert.equal(MAX_RESULTS_PER_TAG, 10);
  const refs = [
    { resultId: 'r-1' }, { resultId: 'gone', path: 'x' }, { resultId: 'r-2' }, { resultId: 'r-3' },
  ];
  assert.deepEqual(selectResultEvictions(refs, lookup, { limit: 10 }), []);
  assert.deepEqual(
    selectResultEvictions(refs, lookup, { limit: 2 }).map(ref => ref.resultId),
    ['gone', 'r-1'],
    '空引用先走，然后是最早的 r-1；r-2 收藏了不删',
  );
  assert.deepEqual(
    selectResultEvictions(refs, lookup, { limit: 1, protect: new Set(['r-3']) }).map(ref => ref.resultId),
    ['gone', 'r-1'],
    '刚画好的 r-3 和收藏的 r-2 都不删，宁可超过上限',
  );
});
