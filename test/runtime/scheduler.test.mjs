import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreparationScheduler, preparationPriority } from '../../.local/test-code/host/runtime/scheduler.js';
import { PageRegistry } from '../../.local/test-code/host/state/pages.js';

const job = (sessionId, order, waiters = 0) => ({ sessionId, order, waiters });
function pages() {
  let time = 0, token = 0;
  const registry = new PageRegistry('host', () => time, () => `${++token}`);
  const open = (pageId, sessionId) => {
    const registration = registry.open({ protocolVersion: 1, pageId, registrationSequence: 1, sessionId }, 'owner');
    let sequence = 0, activationSequence = 0, before;
    return (id = sessionId, overrides = {}) => {
      const view = { sessionId: id, selection: id ? 'selected' : 'none', conversationVisible: true, visible: true, focused: true, closed: false, ...overrides };
      if (!view.closed && view.visible && view.focused && view.conversationVisible && id
        && (!before?.focused || !before.visible || before.sessionId !== id || !before.conversationVisible)) activationSequence++;
      before = view;
      return registry.report({ protocolVersion: 1, pageId, ...registration, sequence: ++sequence, activationSequence, view }, 'owner');
    };
  };
  return { registry, open, expire: () => { time += 60_001; registry.expire(); } };
}

test('strict levels reserve both hash positions and never age a background task into waiting', () => {
  assert.deepEqual([
    preparationPriority('history', true, false), preparationPriority('hash', true, false),
    preparationPriority('history', false, true), preparationPriority('hash', false, false),
    preparationPriority('history', false, false),
  ], [0, 1, 2, 3, 4]);
  const scheduler = new PreparationScheduler(), old = job('old', 1), waiting = job('waiting', 1_000_000, 1);
  assert.equal(scheduler.select([old, waiting], []), waiting);
});

test('equal levels run one fixed task to completion without round robin or same-level interruption', () => {
  const scheduler = new PreparationScheduler(), a = job('a', 1), b = job('b', 2, 1);
  assert.equal(scheduler.select([a, b], []), b);
  a.waiters = 1;
  assert.equal(scheduler.select([a, b], []), b, 'joining the same level does not preempt');
  assert.equal(scheduler.select([a, b], []), b);
  scheduler.finish(b);
  assert.equal(scheduler.select([a], []), a);
});

test('higher priorities preempt only selection boundaries and paused work keeps its original FIFO place', () => {
  const scheduler = new PreparationScheduler(), a = job('a', 1), b = job('b', 2), c = job('c', 3, 1);
  assert.equal(scheduler.select([a, b], []), a);
  assert.equal(scheduler.select([a, b, c], []), c);
  scheduler.finish(c);
  assert.equal(scheduler.select([a, b], []), a);
  assert.equal(a.order, 1);
});

test('A to B to A uses accepted activation order; old-page heartbeats never steal the current task', () => {
  const p = pages(), scheduler = new PreparationScheduler(), a = job('a', 1), b = job('b', 2), tasks = [a, b];
  const first = p.open('first', 'a'), second = p.open('second', 'b');
  first(); assert.equal(scheduler.select(tasks, p.registry.snapshot()), a);
  second(); scheduler.update(tasks, p.registry.snapshot());
  first(); assert.equal(scheduler.select(tasks, p.registry.snapshot()), b);
  first('a', { focused: false }); scheduler.update(tasks, p.registry.snapshot());
  first(); assert.equal(scheduler.select(tasks, p.registry.snapshot()), a);
});

test('blur, hidden, panel, closed and expired pages retain only the current fixed task', () => {
  for (const change of [{ focused: false }, { visible: false }, { conversationVisible: false }, { closed: true }, 'expire']) {
    const p = pages(), scheduler = new PreparationScheduler(), a = job('a', 1), waiting = job('b', 2, 1);
    const report = p.open('page', 'a'); report();
    assert.equal(scheduler.select([a, waiting], p.registry.snapshot()), a);
    if (change === 'expire') p.expire(); else report('a', change);
    assert.equal(scheduler.select([a, waiting], p.registry.snapshot()), a);
    scheduler.finish(a);
    const newDemand = job('a', 3);
    assert.equal(scheduler.select([newDemand, waiting], p.registry.snapshot()), waiting);
    assert.equal(scheduler.priority(newDemand), 4);
  }
});

test('a newer activation received inside a batch survives subsequent close until that target completes', () => {
  const p = pages(), scheduler = new PreparationScheduler(), a = job('a', 1), b = job('b', 2);
  const first = p.open('a-page', 'a'), second = p.open('b-page', 'b');
  first(); assert.equal(scheduler.select([a, b], p.registry.snapshot()), a);
  second(); scheduler.update([a, b], p.registry.snapshot());
  second('b', { closed: true }); scheduler.update([a, b], p.registry.snapshot());
  first(); assert.equal(scheduler.select([a, b], p.registry.snapshot()), b);
  scheduler.finish(b);
  assert.equal(scheduler.select([a], p.registry.snapshot()), a, 'remaining valid active candidate is selected after completion');
});

test('live waiter removal demotes waiting work; a failed or finished current task cannot block the queue', () => {
  const p = pages(), scheduler = new PreparationScheduler(), a = job('a', 1, 1), b = job('b', 2, 1);
  assert.equal(scheduler.select([a, b], []), a);
  a.waiters = 0; assert.equal(scheduler.select([a, b], []), b);
  p.open('current', 'a')(); assert.equal(scheduler.select([a, b], p.registry.snapshot()), a);
  assert.equal(scheduler.priority(a), 0, 'current target survives its waiter cancellation');
  scheduler.finish(a);
  assert.equal(scheduler.select([b], p.registry.snapshot()), b);
  scheduler.clear(); assert.equal(scheduler.select([], []), undefined);
});

test('one current session owns its history and hashes; combined five levels survive blur and switch', () => {
  const p = pages(), scheduler = new PreparationScheduler();
  const current = job('a', 4), hash = { ...job('a', 5), kind: 'hash' }, waiting = job('b', 2, 1), backgroundHash = { ...job('b', 3), kind: 'hash' }, preheat = job('c', 1);
  const tasks = [preheat, waiting, backgroundHash, current, hash], report = p.open('page', 'a'); report();
  assert.equal(scheduler.select(tasks, p.registry.snapshot()), current);
  assert.deepEqual([current, hash, waiting, backgroundHash, preheat].map(t => scheduler.priority(t)), [0, 1, 2, 3, 4]);
  report('a', { focused: false }); scheduler.finish(current);
  assert.equal(scheduler.select(tasks.filter(t => t !== current), p.registry.snapshot()), hash);
  report('b'); assert.equal(scheduler.select(tasks, p.registry.snapshot()), waiting);
  assert.equal(scheduler.priority(hash), 3); assert.equal(scheduler.priority(backgroundHash), 1);
  report('a'); assert.equal(scheduler.select(tasks, p.registry.snapshot()), current);
});
