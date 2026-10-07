import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAG_BYTES_WARN_LIMIT,
  byteLength,
  chatTagsFootprint,
  describeBytes,
  describeFootprint,
  fieldSizes,
  messageTagsFootprint,
  warnIfHeavy,
} from '../../src/ui/state/tag-footprint.js';

test('按 UTF-8 字节数算，不是字符数', () => {
  assert.equal(byteLength('ab'), 4, '含 JSON 引号');
  assert.equal(byteLength('画笺'), 8, '每个汉字 3 字节，加引号');
  assert.equal(byteLength(undefined), 0);
  assert.equal(byteLength({ a: 1 }), 7);
  assert.equal(describeBytes(512), '512 B');
  assert.equal(describeBytes(23 * 1024), '23.0 KB');
  assert.equal(describeBytes(18.7 * 1024 * 1024), '18.70 MB');
});

test('一楼和整个聊天的体积：当前版本和滑动存档分开算，并记下最重的一楼', () => {
  const heavy = { tagId: 't', prompt: 'p', attempts: Array.from({ length: 50 }, () => ({ promptSnapshot: 'x'.repeat(100) })) };
  const chat = [
    { is_user: true, mes: 'hi' },
    { extra: { stImageAtelier: { tags: [{ tagId: 'a', prompt: 'p', resultRefs: [] }] } } },
    {
      extra: { stImageAtelier: { tags: [heavy] } },
      swipe_info: [{ extra: { stImageAtelier: { tags: [heavy] } } }, { extra: {} }],
    },
  ];
  const second = messageTagsFootprint(chat[2]);
  assert.equal(second.active, byteLength([heavy]));
  assert.equal(second.swipes, byteLength([heavy]));
  assert.equal(second.total, second.active * 2);
  assert.equal(second.tags, 1);
  const summary = chatTagsFootprint(chat);
  assert.equal(summary.messages, 2);
  assert.equal(summary.tags, 2);
  assert.equal(summary.activeBytes, byteLength([chat[1].extra.stImageAtelier.tags[0]]) + second.active);
  assert.equal(summary.swipeBytes, second.swipes);
  assert.equal(summary.bytes, summary.activeBytes + summary.swipeBytes);
  assert.deepEqual(summary.heaviest, { messageId: 2, bytes: second.total });
  assert.match(describeFootprint(summary), /2 楼、2 个标签；当前版本 .* KB，滑动存档 .* KB/);
  assert.deepEqual(chatTagsFootprint(undefined), { bytes: 0, activeBytes: 0, swipeBytes: 0, messages: 0, tags: 0, heaviest: null });
});

test('单楼 tags 超过 20 KB 才 console.warn，并列出每个标签各字段的大小', () => {
  assert.equal(TAG_BYTES_WARN_LIMIT, 20 * 1024);
  const warnings = [];
  const warn = (...args) => warnings.push(args);
  const light = { extra: { stImageAtelier: { tags: [{ tagId: 't', prompt: 'p' }] } } };
  assert.equal(warnIfHeavy(light, 3, { warn }).heavy, false);
  assert.equal(warnings.length, 0);

  const prompt = '提示词'.repeat(300);
  const attempts = Array.from({ length: 30 }, (_, index) => ({ attemptId: String(index), promptSnapshot: prompt }));
  const heavy = { extra: { stImageAtelier: { tags: [{ tagId: 'heavy-tag', prompt, attempts, resultRefs: [] }] } } };
  const report = warnIfHeavy(heavy, 7, { warn });
  assert.equal(report.heavy, true);
  assert.ok(report.bytes > TAG_BYTES_WARN_LIMIT);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /第 7 楼的生图标签数据有 .* KB，超过 20\.0 KB/);
  assert.equal(warnings[0][1][0].标签, 'heavy-tag');
  assert.match(warnings[0][1][0].字段.attempts, /KB$/);
  assert.match(warnings[0][1][0].字段.prompt, /KB$/);
  const sizes = fieldSizes(heavy.extra.stImageAtelier.tags[0]);
  assert.deepEqual(Object.keys(sizes)[0], 'attempts', '最大的字段排最前');
});
