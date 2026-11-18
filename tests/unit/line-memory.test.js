/* 2.7.1 线路记忆（src/ui/api/line-memory.js）：哪条线路明确拒过哪个参数，记在本机、记一天。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineMemory, LINE_MEMORY_KEY, LINE_MEMORY_TTL_MS } from '../../src/ui/api/line-memory.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    writes: 0,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem(key, value) { this.writes += 1; values.set(key, String(value)); },
    removeItem(key) { this.writes += 1; values.delete(key); },
  };
}

const HOUR = 60 * 60 * 1000;
const LINE_A = 'p1|https://a.test|/v1/images/edits|gpt-image-1';
const LINE_B = 'p2|https://b.test|/v1/images/generations|gpt-image-1';

test('记下来的参数：同一条线路认得，别的线路、别的参数不受影响；存进了本机', () => {
  const storage = memoryStorage();
  const memory = createLineMemory({ storage, now: () => 1_000 });
  assert.equal(memory.has(LINE_A, 'input_fidelity'), false);
  memory.remember(LINE_A, ['input_fidelity']);
  assert.equal(memory.has(LINE_A, 'input_fidelity'), true);
  assert.equal(memory.has(LINE_A, 'response_format'), false);
  assert.equal(memory.has(LINE_B, 'input_fidelity'), false);
  assert.deepEqual(JSON.parse(storage.values.get(LINE_MEMORY_KEY)), { v: 1, lines: { [LINE_A]: { input_fidelity: 1_000 } } });
});

test('刷新页面（新建一个）后还记得；两个页面同时开着，一边记下的另一边马上认得', () => {
  const storage = memoryStorage();
  const first = createLineMemory({ storage, now: () => 1_000 });
  const other = createLineMemory({ storage, now: () => 1_000 });
  first.remember(LINE_A, ['input_fidelity', 'response_format']);
  assert.equal(other.has(LINE_A, 'response_format'), true, '另一个页面不用刷新就认得');
  const reloaded = createLineMemory({ storage, now: () => 2_000 });
  assert.equal(reloaded.has(LINE_A, 'input_fidelity'), true);
  assert.equal(reloaded.has(LINE_A, 'response_format'), true);
  /* 一边忘了，另一边也跟着忘。 */
  other.forget('input_fidelity');
  assert.equal(first.has(LINE_A, 'input_fidelity'), false);
  assert.equal(first.has(LINE_A, 'response_format'), true);
});

test('只记一天：到点了就当没记过（线路以后接上了会自动再带着试一次），过期的顺手从本机清掉', () => {
  const storage = memoryStorage();
  let clock = 10 * HOUR;
  const memory = createLineMemory({ storage, now: () => clock });
  assert.equal(LINE_MEMORY_TTL_MS, 24 * HOUR);
  memory.remember(LINE_A, ['input_fidelity']);
  clock += 5 * HOUR;
  memory.remember(LINE_A, ['response_format']);
  clock += 18 * HOUR + 59 * 60 * 1000;
  assert.equal(memory.has(LINE_A, 'input_fidelity'), true, '差一分钟满一天');
  clock += 60 * 1000;
  assert.equal(memory.has(LINE_A, 'input_fidelity'), false, '满一天');
  assert.equal(memory.has(LINE_A, 'response_format'), true, '后记的那个还没到');
  assert.deepEqual(JSON.parse(storage.values.get(LINE_MEMORY_KEY)).lines, { [LINE_A]: { response_format: 15 * HOUR } });
  clock += 5 * HOUR;
  assert.equal(memory.has(LINE_A, 'response_format'), false);
  assert.equal(storage.values.has(LINE_MEMORY_KEY), false, '一条不剩就把这一项删掉');
  /* 被拒了再记一次：从这一刻重新算一天。 */
  memory.remember(LINE_A, ['response_format']);
  clock += 23 * HOUR;
  assert.equal(memory.has(LINE_A, 'response_format'), true);
  /* 设备的钟被往回拨了一大截（比记下的时刻还早一天多）：也不会因此永远记着。 */
  clock -= 23 * HOUR + 25 * HOUR;
  assert.equal(memory.has(LINE_A, 'response_format'), false);
});

test('忘掉：可以只忘某个预设的线路；重复记同一个参数不重复写本机', () => {
  const storage = memoryStorage();
  const memory = createLineMemory({ storage, now: () => 1_000 });
  memory.remember(LINE_A, ['response_format', 'input_fidelity']);
  memory.remember(LINE_B, ['response_format']);
  memory.forget('response_format', 'p1');
  assert.equal(memory.has(LINE_A, 'response_format'), false);
  assert.equal(memory.has(LINE_A, 'input_fidelity'), true);
  assert.equal(memory.has(LINE_B, 'response_format'), true, '别的预设不动');
  memory.forget('response_format');
  assert.equal(memory.has(LINE_B, 'response_format'), false);
  const writes = storage.writes;
  memory.forget('response_format');
  memory.remember(LINE_A, []);
  assert.equal(storage.writes, writes, '没变化就不写');
  assert.deepEqual(memory.snapshot(), [{ line: LINE_A, parameter: 'input_fidelity', learnedAt: 1_000, expiresAt: 1_000 + LINE_MEMORY_TTL_MS }]);
});

test('本机存不了（隐私模式、被禁用、存满了）、存的东西被弄坏：退回只记在这次打开页面期间，不报错', () => {
  const broken = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  for (const storage of [broken, null, undefined]) {
    const memory = createLineMemory({ storage, now: () => 1_000 });
    assert.equal(memory.has(LINE_A, 'input_fidelity'), false);
    memory.remember(LINE_A, ['input_fidelity']);
    assert.equal(memory.has(LINE_A, 'input_fidelity'), true, '这次打开页面期间照样记得');
    memory.forget('input_fidelity');
    assert.equal(memory.has(LINE_A, 'input_fidelity'), false);
  }
  /* 能读不能写：照样记在内存里，也认得之前存下的。 */
  const readOnly = memoryStorage({ [LINE_MEMORY_KEY]: JSON.stringify({ v: 1, lines: { [LINE_B]: { response_format: 900 } } }) });
  readOnly.setItem = () => { throw new Error('QuotaExceededError'); };
  const partial = createLineMemory({ storage: readOnly, now: () => 1_000 });
  assert.equal(partial.has(LINE_B, 'response_format'), true);
  partial.remember(LINE_A, ['input_fidelity']);
  assert.equal(partial.has(LINE_A, 'input_fidelity'), true);

  for (const garbage of ['{不是 JSON', '[]', 'null', JSON.stringify({ v: 2, lines: { [LINE_A]: { input_fidelity: 900 } } }), JSON.stringify({ v: 1, lines: { [LINE_A]: { input_fidelity: '昨天' }, x: null } })]) {
    const storage = memoryStorage({ [LINE_MEMORY_KEY]: garbage });
    const memory = createLineMemory({ storage, now: () => 1_000 });
    assert.equal(memory.has(LINE_A, 'input_fidelity'), false, garbage);
    memory.remember(LINE_A, ['input_fidelity']);
    assert.equal(memory.has(LINE_A, 'input_fidelity'), true, garbage);
    assert.deepEqual(JSON.parse(storage.values.get(LINE_MEMORY_KEY)), { v: 1, lines: { [LINE_A]: { input_fidelity: 1_000 } } }, '坏的那份被好的盖掉');
  }
});

test('最多记 40 条线路：再多就丢掉最早记的', () => {
  const storage = memoryStorage();
  let clock = 0;
  const memory = createLineMemory({ storage, now: () => clock });
  for (let index = 0; index < 45; index += 1) {
    clock = index;
    memory.remember(`p${index}|https://x.test|/v1/images/generations|m`, ['response_format']);
  }
  const lines = Object.keys(JSON.parse(storage.values.get(LINE_MEMORY_KEY)).lines);
  assert.equal(lines.length, 40);
  assert.equal(memory.has('p0|https://x.test|/v1/images/generations|m', 'response_format'), false);
  assert.equal(memory.has('p44|https://x.test|/v1/images/generations|m', 'response_format'), true);
});
