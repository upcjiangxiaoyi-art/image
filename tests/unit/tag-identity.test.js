import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegacyMetadata,
  legacyTagRecord,
  locateTag,
  metadataTagIds,
  reconcileMessage,
  sameRef,
} from '../../src/ui/state/tag-identity.js';
import { promptHash } from '../../src/ui/api/chat-tag-store.js';

const tag = prompt => ({ prompt, ratio: undefined, quality: undefined, count: 1 });

function counter() {
  let count = 0;
  return () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`;
}

/* 模拟侧文件：记录按 tagId 放着。 */
function memory() {
  const map = new Map();
  return {
    records: tagId => map.get(tagId) || null,
    absorb: result => { for (const [tagId, record] of Object.entries(result.records)) map.set(tagId, record); },
    map,
  };
}

test('第一次识别：楼里只留 { messageUuid, tagIds }，记录另放；刷新再识别复用 ID、什么都不改', () => {
  const uuid = counter();
  const side = memory();
  const message = { extra: {} };
  const first = reconcileMessage(message, [tag('A'), tag('B')], { records: side.records, uuid });
  assert.deepEqual(Object.keys(first.ref), ['messageUuid', 'tagIds']);
  assert.equal(first.ref.tagIds.length, 2);
  assert.equal(first.refChanged, true);
  assert.equal(first.legacy, false);
  assert.ok(JSON.stringify(first.ref).length < 160, `两个标签的引用 ${JSON.stringify(first.ref).length} 字节（一个标签一百来字节）`);
  assert.deepEqual(first.tags.map(item => [item.ordinal, item.prompt, item.latestResultId, item.autoAttempted]), [[0, 'A', null, false], [1, 'B', null, false]]);
  assert.deepEqual(Object.keys(first.records[first.ref.tagIds[0]]), ['promptHash', 'latestResultId', 'resultRefs', 'autoAttempted', 'autoSuppressed']);
  assert.equal(first.records[first.ref.tagIds[0]].promptHash, promptHash('A'));
  side.absorb(first);
  message.extra.stImageAtelier = first.ref;

  const second = reconcileMessage(message, [tag('A'), tag('B')], { records: side.records, uuid });
  assert.deepEqual(second.ref, first.ref);
  assert.equal(second.refChanged, false, '一样的引用不算改动，不触发保存聊天');
  assert.equal(second.identityChanged, false);
  assert.deepEqual(second.records, first.records, '记录也一样，侧文件不会写');
});

test('编辑后未变的标签保留 ID、状态跟着；变了的标签拿新 ID；顺序换了只换引用', () => {
  const uuid = counter();
  const side = memory();
  const message = { extra: {} };
  const first = reconcileMessage(message, [tag('A'), tag('B')], { records: side.records, uuid });
  side.absorb(first);
  message.extra.stImageAtelier = first.ref;
  const [idA, idB] = first.ref.tagIds;
  side.map.set(idA, { ...side.map.get(idA), latestResultId: 'r-a', autoAttempted: true });

  const next = reconcileMessage(message, [tag('A'), tag('C')], { records: side.records, uuid });
  assert.equal(next.ref.tagIds[0], idA);
  assert.notEqual(next.ref.tagIds[1], idB);
  assert.equal(next.refChanged, true);
  assert.equal(next.identityChanged, true);
  assert.equal(next.tags[0].latestResultId, 'r-a', '老标签的状态从侧文件带过来');
  assert.equal(next.tags[0].autoAttempted, true);
  assert.equal(next.tags[1].latestResultId, null);
  side.absorb(next);
  message.extra.stImageAtelier = next.ref;

  const swapped = reconcileMessage(message, [tag('C'), tag('A')], { records: side.records, uuid });
  assert.deepEqual(swapped.ref.tagIds, [next.ref.tagIds[1], idA], '换顺序只是引用里的顺序变了，ID 不变');
  assert.deepEqual(swapped.tags.map(item => item.ordinal), [0, 1]);
});

test('旧格式的楼：不动它，状态从楼里那份顶上；只有标签变了才升级成引用', () => {
  const uuid = counter();
  const legacy = {
    extra: {
      stImageAtelier: {
        messageUuid: 'm-legacy',
        tags: [{
          tagId: 't-legacy', prompt: 'A', ordinal: 0, count: 1, latestResultId: 'r1',
          resultRefs: [{ resultId: 'r1', path: 'user/images/st-image-atelier/r1.png', createdAt: '' }],
          autoAttempted: true, autoSuppressed: false,
        }],
        schemaVersion: 2,
      },
    },
  };
  const same = reconcileMessage(legacy, [tag('A')], { records: () => null, uuid });
  assert.equal(same.legacy, true);
  assert.equal(same.identityChanged, false, '标签没变：不升级、不动聊天');
  assert.equal(same.refChanged, true, '引用和楼里存的（旧格式）当然不一样，但调用方看 identityChanged');
  assert.deepEqual(same.ref, { messageUuid: 'm-legacy', tagIds: ['t-legacy'] });
  assert.equal(same.tags[0].latestResultId, 'r1', '状态从楼里的旧数据顶上');
  assert.deepEqual(same.records['t-legacy'], legacyTagRecord(legacy.extra.stImageAtelier.tags[0]));

  const edited = reconcileMessage(legacy, [tag('A'), tag('B')], { records: () => null, uuid });
  assert.equal(edited.identityChanged, true, '多了一个标签：这楼要升级成引用');
  assert.equal(edited.ref.tagIds[0], 't-legacy');
  assert.equal(edited.ref.messageUuid, 'm-legacy', 'messageUuid 沿用');
});

test('旧格式标签 → 记录：resultRefs 原样、只有 resultIds 的变成没路径的引用、布尔兜底', () => {
  assert.deepEqual(legacyTagRecord({ prompt: 'A', latestResultId: 'r', resultIds: ['r', 'q'], autoAttempted: 1 }), {
    promptHash: promptHash('A'),
    latestResultId: 'r',
    resultRefs: [{ resultId: 'r', path: '', createdAt: '' }, { resultId: 'q', path: '', createdAt: '' }],
    autoAttempted: false,
    autoSuppressed: false,
  });
  assert.equal(isLegacyMetadata({ tags: [] }), true);
  assert.equal(isLegacyMetadata({ messageUuid: 'm', tagIds: [] }), false);
  assert.deepEqual(metadataTagIds({ tags: [{ tagId: 'a' }, {}, { tagId: 'b' }] }), ['a', 'b']);
  assert.deepEqual(metadataTagIds({ tagIds: ['a', 7, 'b'] }), ['a', 'b']);
  assert.equal(sameRef({ messageUuid: 'm', tagIds: ['a'] }, { messageUuid: 'm', tagIds: ['a'] }), true);
  assert.equal(sameRef({ messageUuid: 'm', tagIds: ['a'], schemaVersion: 2 }, { messageUuid: 'm', tagIds: ['a'] }), false, '多余字段也算不一样，一次性收干净');
  assert.equal(sameRef({ messageUuid: 'm', tags: [{ tagId: 'a' }] }, { messageUuid: 'm', tagIds: ['a'] }), false);
});

const refWith = (...tagIds) => ({ messageUuid: 'm-1', tagIds });

test('找标签：先找每一层当前显示的版本，再找同一层其他滑动版本的存档；提示词从对应那一版的正文里解析', () => {
  const message = {
    mes: '新的一版 <draw>current prompt</draw>',
    swipe_id: 1,
    swipes: ['旧的一版 <draw>old prompt</draw>', '新的一版 <draw>current prompt</draw>'],
    swipe_info: [
      { extra: { stImageAtelier: refWith('old') } },
      { extra: { stImageAtelier: refWith('stale-copy') } },
    ],
    extra: { stImageAtelier: refWith('current') },
  };
  const chat = [{ is_user: true, mes: '你好' }, message];

  const current = locateTag(chat, 'current');
  assert.equal(current.placement, 'active');
  assert.equal(current.ordinal, 0);
  assert.equal(current.prompt, 'current prompt');
  assert.equal(current.message, message);

  const swiped = locateTag(chat, 'old');
  assert.equal(swiped.placement, 'swipe');
  assert.equal(swiped.swipeId, 0);
  assert.equal(swiped.message, message);
  assert.equal(swiped.prompt, 'old prompt', '从那一版的正文里解析');

  assert.equal(locateTag(chat, 'stale-copy'), null, '当前显示那一版自己的存档是过期拷贝，不算');
  assert.equal(locateTag(chat, 'missing'), null, '回复被重新生成、删除或改动过');
  assert.equal(locateTag(undefined, 'current'), null);
});

test('旧格式的楼也找得到：提示词退回楼里存的那份，ordinal 按楼里记的', () => {
  const legacy = { messageUuid: 'm', tags: [{ tagId: 'l1', prompt: 'legacy prompt', ordinal: 0 }] };
  const message = { mes: '正文（标签已经被正则改掉了）', extra: { stImageAtelier: legacy } };
  const found = locateTag([message], 'l1');
  assert.equal(found.placement, 'active');
  assert.equal(found.prompt, 'legacy prompt');
  assert.equal(found.tag, legacy.tags[0]);
});

test('正在生成新的滑动版本时，这一层的 extra 还是上一版留下的，以上一版的存档为准', () => {
  const previous = refWith('t1');
  const message = {
    swipe_id: 1,
    swipes: ['旧的一版 <draw>p</draw>'],
    swipe_info: [{ extra: { stImageAtelier: structuredClone(previous) } }],
    extra: { stImageAtelier: previous },
  };
  const found = locateTag([message], 't1');
  assert.equal(found.placement, 'swipe', '不开流式：新版本的位置还空着');
  assert.equal(found.prompt, 'p');

  message.swipes.push('写到一半');
  message.swipe_info.push({ extra: { stImageAtelier: structuredClone(previous) } });
  assert.equal(locateTag([message], 't1').placement, 'active', '写完了、也不在流式输出，就是当前这一版');
  assert.equal(
    locateTag([message], 't1', { isStreaming: messageId => messageId === 0 }).placement,
    'swipe',
    '开流式：新版本正在写',
  );

  const continued = { extra: { stImageAtelier: refWith('t2') } };
  assert.equal(
    locateTag([continued], 't2', { isStreaming: () => true }).placement,
    'active',
    '「继续」也在流式输出，但没有别的版本存着这张卡，还是当前这一版',
  );
});
