import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageRegistry } from '../../.local/test-code/host/state/pages.js';

const view = (sessionId = 'A', extra = {}) => ({ sessionId, selection: sessionId ? 'selected' : 'none', conversationVisible: true, visible: true, focused: true, closed: false, ...extra });
function fixture() {
  let time = 0, token = 0;
  const pages = new PageRegistry('host-1', () => time, () => `token-${++token}`);
  const open = (pageId = 'page-1', registrationSequence = 1, owner = 'owner') => ({
    protocolVersion: 1, pageId, ...pages.open({ protocolVersion: 1, pageId, registrationSequence, sessionId: 'A' }, owner),
  });
  const report = (registration, sequence, state = view(), owner = 'owner') => pages.report({ activationSequence: 0, ...registration, sequence, view: state }, owner);
  return { pages, open, report, advance: ms => { time += ms; } };
}

test('A→B→A and multiple pages order actual activation, not heartbeats or registration', () => {
  const { pages, open, report } = fixture();
  const a = open();
  assert.equal(pages.snapshot()[0].active, false);
  report(a, 1);
  report(a, 2, view('B'));
  report(a, 3, view('A'));
  const b = open('page-2');
  report(b, 1, view('B'));
  report(a, 4);
  assert.deepEqual(pages.snapshot().map(p => p.activationOrder), [3, 4]);
  report(a, 5, view('A', { focused: false }));
  report(a, 6, view('A', { focused: false }));
  assert.equal(pages.snapshot()[0].activationOrder, 3);
  report(a, 7);
  assert.equal(pages.snapshot()[0].activationOrder, 5);
});

test('stale reports and idempotent registration cannot renew the monotonic 60s lease', () => {
  const { pages, open, report, advance } = fixture();
  const a = open();
  report(a, 2);
  advance(59_999);
  assert.equal(report(a, 1, view('B')).accepted, false);
  assert.deepEqual(open(), a);
  assert.equal(pages.snapshot()[0].lastReceivedAt, 0);
  advance(1);
  assert.equal(pages.snapshot()[0].phase, 'expired');
  assert.throws(() => report(a, 3), { code: 'recall/re-register' });
  assert.throws(() => open(), { code: 'recall/re-register' });
  const replacement = open('page-1', 2);
  report(replacement, 1, view('B'));
  assert.throws(() => report(a, 4), { code: 'recall/re-register' });
  assert.equal(pages.snapshot()[0].view.sessionId, 'B');
});

test('capabilities are bound to principal, registration sequence and Host epoch', () => {
  const { pages, open, report } = fixture();
  const old = open();
  report(old, 1);
  const next = open('page-1', 2);
  report(next, 1);
  assert.equal(pages.snapshot()[0].activationOrder, 1, 'reconnect is not a focus edge');
  assert.throws(() => open(), { code: 'recall/page-conflict' });
  assert.throws(() => open('page-1', 3, 'another-user'), { code: 'recall/page-conflict' });
  assert.throws(() => report(next, 2, view(), 'another-user'), { code: 'recall/re-register' });
  assert.throws(() => report(old, 99), { code: 'recall/re-register' });
  assert.throws(() => report({ ...next, hostEpoch: 'previous-host' }, 2), { code: 'recall/re-register' });
  assert.equal(pages.snapshot()[0].sequence, 1);
  assert.equal('registrationId' in pages.snapshot()[0], false);
});

test('panels, ambiguous/empty selection, hidden, blur and pagehide withdraw activity', () => {
  const { pages, open, report, advance } = fixture();
  const a = open();
  for (const [i, state] of [view('A', { conversationVisible: false }), view(null), view(null, { selection: 'ambiguous' }), view('A', { visible: false }), view('A', { focused: false }), view('A', { closed: true })].entries()) {
    report(a, i + 1, state);
    assert.equal(pages.snapshot()[0].active, false);
    assert.equal(pages.snapshot()[0].activationOrder, 0);
  }
  assert.throws(() => report(a, 7), { code: 'recall/re-register' });
  advance(120_000);
  assert.equal(pages.snapshot().length, 0);
  const newPage = open();
  assert.throws(() => report(a, 8), { code: 'recall/re-register' });
  report(newPage, 1);
  pages.clear();
  assert.equal(pages.snapshot().length, 0);
});

test('malformed identifiers, sequence numbers and inconsistent selection are rejected', () => {
  const { pages, open, report } = fixture();
  const a = open();
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => report(a, sequence), { code: 'recall/invalid-report' });
  assert.throws(() => report(a, 1, view(null, { selection: 'selected' })), { code: 'recall/invalid-report' });
  assert.throws(() => open('x'.repeat(257)), { code: 'recall/invalid-report' });
  assert.equal(pages.snapshot()[0].sequence, 0);
});

test('coalesced activation edges survive A→B→A, but reconnect and heartbeat do not add edges', () => {
  const { pages, open, report } = fixture();
  const a = open();
  report({ ...a, activationSequence: 1 }, 1);
  const other = open('page-2');
  report({ ...other, activationSequence: 1 }, 1, view('B'));
  // The intermediate B report was coalesced during a slow RPC. Its following
  // A activation must still become newer than page-2's activation.
  report({ ...a, activationSequence: 3 }, 2);
  assert.deepEqual(pages.snapshot().map(p => p.activationOrder), [3, 2]);
  const next = open('page-1', 2);
  report({ ...next, activationSequence: 3 }, 1);
  report({ ...next, activationSequence: 3 }, 2);
  assert.equal(pages.snapshot()[0].activationOrder, 3);
  assert.throws(() => report({ ...next, activationSequence: 2 }, 3), { code: 'recall/invalid-report' });
});
