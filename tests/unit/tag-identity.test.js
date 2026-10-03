import test from 'node:test';
import assert from 'node:assert/strict';
import { locateTag, reconcileTagMetadata } from '../../src/ui/state/tag-identity.js';

const tag = prompt => ({ prompt, ratio: undefined, quality: undefined, count: 1 });

test('首次生成并在刷新时复用 messageUuid 和 tagId', () => {
  let count = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`;
  const message = { extra: {} };
  const first = reconcileTagMetadata(message, [tag('A'), tag('B')], uuid);
  const ids = first.metadata.tags.map(item => item.tagId);
  const messageUuid = first.metadata.messageUuid;
  const second = reconcileTagMetadata(message, [tag('A'), tag('B')], uuid);
  assert.deepEqual(second.metadata.tags.map(item => item.tagId), ids);
  assert.equal(second.metadata.messageUuid, messageUuid);
  assert.equal(second.changed, false);
});

test('编辑后未变标签保留 ID，变更标签获得新 ID', () => {
  let count = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`;
  const message = { extra: {} };
  const first = reconcileTagMetadata(message, [tag('A'), tag('B')], uuid).metadata;
  const next = reconcileTagMetadata(message, [tag('A'), tag('C')], uuid).metadata;
  assert.equal(next.tags[0].tagId, first.tags[0].tagId);
  assert.notEqual(next.tags[1].tagId, first.tags[1].tagId);
});

const metadataWith = tagId => ({ messageUuid: 'm-1', schemaVersion: 2, tags: [{ tagId, prompt: tagId }] });

test('找标签：先找每一层当前显示的版本，再找同一层其他滑动版本的存档', () => {
  const message = {
    mes: '新的一版',
    swipe_id: 1,
    swipes: ['旧的一版', '新的一版'],
    swipe_info: [
      { extra: { stImageAtelier: metadataWith('old') } },
      { extra: { stImageAtelier: metadataWith('stale-copy') } },
    ],
    extra: { stImageAtelier: metadataWith('current') },
  };
  const chat = [{ is_user: true, mes: '你好' }, message];

  const current = locateTag(chat, 'current');
  assert.equal(current.placement, 'active');
  assert.equal(current.tag, message.extra.stImageAtelier.tags[0]);

  const swiped = locateTag(chat, 'old');
  assert.equal(swiped.placement, 'swipe');
  assert.equal(swiped.message, message);
  assert.equal(swiped.tag, message.swipe_info[0].extra.stImageAtelier.tags[0], '直接改存档里那份，滑回去酒馆会拷回来');

  assert.equal(locateTag(chat, 'stale-copy'), null, '当前显示那一版自己的存档是过期拷贝，不算');
  assert.equal(locateTag(chat, 'missing'), null, '回复被重新生成、删除或改动过');
  assert.equal(locateTag(undefined, 'current'), null);
});

test('正在生成新的滑动版本时，这一层的 extra 还是上一版留下的，以上一版的存档为准', () => {
  const previous = metadataWith('t1');
  const message = {
    swipe_id: 1,
    swipes: ['旧的一版'],
    swipe_info: [{ extra: { stImageAtelier: structuredClone(previous) } }],
    extra: { stImageAtelier: previous },
  };
  const found = locateTag([message], 't1');
  assert.equal(found.placement, 'swipe', '不开流式：新版本的位置还空着');
  assert.equal(found.tag, message.swipe_info[0].extra.stImageAtelier.tags[0]);

  message.swipes.push('写到一半');
  message.swipe_info.push({ extra: { stImageAtelier: structuredClone(previous) } });
  assert.equal(locateTag([message], 't1').placement, 'active', '写完了、也不在流式输出，就是当前这一版');
  assert.equal(
    locateTag([message], 't1', { isStreaming: messageId => messageId === 0 }).placement,
    'swipe',
    '开流式：新版本正在写',
  );

  const continued = { extra: { stImageAtelier: metadataWith('t2') } };
  assert.equal(
    locateTag([continued], 't2', { isStreaming: () => true }).placement,
    'active',
    '「继续」也在流式输出，但没有别的版本存着这张卡，还是当前这一版',
  );
});

test('重新识别没变的标签不算改动（不触发保存聊天）；旧数据里的 results 原样带上等着迁移', () => {
  let count = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`;
  const message = { extra: {} };
  const first = reconcileTagMetadata(message, [tag('A')], uuid);
  assert.equal(first.changed, true);
  assert.equal(Object.hasOwn(first.metadata.tags[0], 'results'), false, '新标签不带旧版的 results 字段');
  assert.equal(reconcileTagMetadata(message, [tag('A')], uuid).changed, false);

  const legacy = { extra: { stImageAtelier: { messageUuid: 'm', schemaVersion: 2, tags: [{ tagId: 't', prompt: 'A', results: [{ resultId: 'r' }] }] } } };
  const migrated = reconcileTagMetadata(legacy, [tag('A')], uuid).metadata.tags[0];
  assert.deepEqual(migrated.results, [{ resultId: 'r' }], '旧数据里的 results 留着，读状态时迁进画廊');
});
