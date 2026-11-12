/* 2.3.0 版本号和更新提示。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../../src/shared/constants.js';
import {
  RELEASE_NOTES,
  compareVersions,
  createVersionMemory,
  notesSince,
  planUpdateNotice,
} from '../../src/shared/release-notes.js';

test('更新说明的第一条就是当前版本，版本号从新到旧，每条一句话', () => {
  assert.equal(RELEASE_NOTES[0].version, VERSION, '发版时忘了在 release-notes.js 最前面加一条');
  for (let index = 1; index < RELEASE_NOTES.length; index += 1) {
    assert.ok(compareVersions(RELEASE_NOTES[index - 1].version, RELEASE_NOTES[index].version) > 0, '从新到旧排');
  }
  for (const note of RELEASE_NOTES) {
    assert.match(note.version, /^\d+\.\d+\.\d+$/);
    assert.match(note.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(note.summary.length >= 6 && note.summary.length <= 48, `${note.version} 的说明要一句话：${note.summary.length} 字`);
  }
  assert.ok(RELEASE_NOTES.length <= 12, '只留最近十来条');
});

test('版本号按数字比，不按字符串比', () => {
  assert.ok(compareVersions('2.10.0', '2.9.0') > 0);
  assert.ok(compareVersions('2.0.3', '2.0.10') < 0);
  assert.equal(compareVersions('2.3.0', '2.3.0'), 0);
  assert.ok(compareVersions('2.3', '2.2.9') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
});

const NOTES = [
  { version: '2.3.0', date: '2026-11-12', summary: '三' },
  { version: '2.2.0', date: '2026-11-12', summary: '二' },
  { version: '2.1.0', date: '2026-11-12', summary: '一' },
  { version: '2.0.3', date: '2026-11-12', summary: '零' },
];

test('notesSince：只给比上次见到的版本新的；上次的版本认不出来就只给最新一条', () => {
  assert.deepEqual(notesSince('2.1.0', NOTES).map(note => note.version), ['2.3.0', '2.2.0']);
  assert.deepEqual(notesSince('2.3.0', NOTES), []);
  assert.deepEqual(notesSince('1.0.0', NOTES).length, 4);
  assert.deepEqual(notesSince(null, NOTES).map(note => note.version), ['2.3.0']);
  assert.deepEqual(notesSince('随便写的', NOTES).map(note => note.version), ['2.3.0']);
});

test('更新后第一次打开才提示：版本没变、全新安装、降级都不提示；跳了好几版只列最近三条', () => {
  assert.equal(planUpdateNotice({ current: '2.3.0', seen: '2.3.0', existingUser: true, notes: NOTES }), null, '版本没变');
  assert.equal(planUpdateNotice({ current: '2.3.0', seen: null, existingUser: false, notes: NOTES }), null, '全新安装');
  assert.equal(planUpdateNotice({ current: '2.2.0', seen: '2.3.0', existingUser: true, notes: NOTES }), null, '降级');

  const one = planUpdateNotice({ current: '2.3.0', seen: '2.2.0', existingUser: true, notes: NOTES });
  assert.equal(one.title, '画笺已更新到 2.3.0');
  assert.equal(one.text, '2.3.0：三');

  const firstTime = planUpdateNotice({ current: '2.3.0', seen: null, existingUser: true, notes: NOTES });
  assert.equal(firstTime.text, '2.3.0：三', '以前就在用、但这台设备还没记过版本：提示最新一条');

  const many = planUpdateNotice({ current: '2.3.0', seen: '1.0.0', existingUser: true, notes: NOTES });
  assert.equal(many.text, '2.3.0：三；2.2.0：二；2.1.0：一；还有 1 条在「设置 → 最近更新」里');
  assert.equal(many.notes.length, 3);
});

test('记住见过的版本：本机存储能用就存，用不了就只在这次页面里记着', () => {
  const store = new Map();
  const memory = createVersionMemory({ getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) });
  assert.equal(memory.read(), null);
  memory.write('2.3.0');
  assert.equal(memory.read(), '2.3.0');
  assert.equal(store.get('stImageAtelier.seenVersion'), '2.3.0');

  const broken = createVersionMemory({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
  assert.equal(broken.read(), null);
  broken.write('2.3.0');
  assert.equal(broken.read(), '2.3.0', '存不了也不会在同一个页面里重复提示');
  assert.equal(createVersionMemory(undefined).read(), null);
});
