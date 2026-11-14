import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageObserver } from '../../.local/test-code/client/observer.js';
import { PageReporter } from '../../.local/test-code/client/reporter.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, value });
const active = sessionId => ({ sessionId, selection: 'selected', conversationVisible: true, visible: true, focused: true, closed: false });
function store(initial) {
  let state = initial;
  const listeners = new Set();
  return { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set: value => { state = value; for (const fn of listeners) fn(); }, listeners };
}
const rows = (...ids) => ({ byId: Object.fromEntries(ids.map(id => [id, { id, retainedBy: { mainView: 1 } }])) });

test('initial public snapshots, coalesced navigation and persistent double mainView ownership', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sessions = store(rows('A')), panel = store({ activePanelId: null });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true });
  const window = new EventTarget();
  const reports = [];
  const observer = new PageObserver({ sessions, panel, document, window }, () => reports.push(observer.read()), () => {});
  t.after(() => observer.dispose());
  t.mock.timers.tick(0);
  assert.equal(reports[0].sessionId, 'A');
  sessions.set(rows('A', 'B'));
  sessions.set(rows('B'));
  t.mock.timers.tick(0);
  assert.deepEqual(reports.map(r => r.sessionId), ['A', 'B']);
  sessions.set(rows('A', 'B'));
  t.mock.timers.tick(0);
  assert.equal(reports.at(-1).selection, 'ambiguous');
  assert.equal(reports.at(-1).sessionId, null);
  sessions.set(rows());
  panel.set({ activePanelId: 'settings' });
  t.mock.timers.tick(0);
  assert.equal(reports.at(-1).selection, 'none');
  assert.equal(reports.at(-1).conversationVisible, false);
  observer.dispose();
  assert.equal(sessions.listeners.size + panel.listeners.size, 0);
  sessions.set(rows('C'));
  t.mock.timers.tick(0);
  assert.equal(reports.length, 4);
});

test('visibility/focus/pagehide are immediate; BFCache restore starts a fresh registration', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let focused = true, restored = 0;
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focused });
  const window = new EventTarget(), reports = [];
  const observer = new PageObserver({ sessions: store(rows('A')), panel: store({ activePanelId: null }), document, window }, () => reports.push(observer.read()), () => restored++);
  focused = false;
  window.dispatchEvent(new Event('blur'));
  assert.equal(reports.at(-1).focused, false);
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(reports.at(-1).visible, false);
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(reports.at(-1).closed, true);
  window.dispatchEvent(new Event('pageshow'));
  assert.equal(restored, 1);
  assert.equal(reports.at(-1).closed, false);
  observer.dispose();
  const count = reports.length;
  window.dispatchEvent(new Event('pagehide'));
  t.mock.timers.tick(0);
  assert.equal(reports.length, count);
});

test('registration and queued reports resample current state; no simultaneous RPCs', async t => {
  let state = active('A'), complete;
  const sent = [];
  const remote = {
    openPage: () => new Promise(resolve => { complete = resolve; }),
    reportView: async report => { sent.push(report); return ok({ accepted: true, reason: 'accepted', hostEpoch: 'epoch' }); },
  };
  const reporter = new PageReporter('page', remote, () => state);
  t.after(() => reporter.dispose());
  reporter.request();
  state = active('B'); reporter.request();
  state = active('C'); reporter.request();
  assert.equal(sent.length, 0);
  complete(ok({ hostEpoch: 'epoch', registrationId: 'credential' }));
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].view.sessionId, 'C');
  assert.equal(sent[0].sequence, 1);
});

test('unfocused heartbeat persists, Host epoch repair is bounded, disposal stops all reports', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let epoch = 'one', opens = 0;
  const sent = [];
  const remote = {
    openPage: async () => { opens++; return ok({ hostEpoch: epoch, registrationId: 'token' }); },
    reportView: async report => {
      sent.push(report);
      return report.hostEpoch === epoch ? ok({ hostEpoch: epoch, accepted: true, reason: 'accepted' }) : { ok: false, error: { code: 'recall/re-register' } };
    },
  };
  const reporter = new PageReporter('page', remote, () => ({ ...active('A'), focused: false }));
  reporter.request(); await settle();
  t.mock.timers.tick(5000); await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].view.focused, false);
  epoch = 'two';
  t.mock.timers.tick(5000); await settle();
  assert.equal(opens, 2);
  assert.equal(sent.at(-1).hostEpoch, 'two');
  assert.equal(sent.at(-1).sequence, 1);
  remote.reportView = async () => ({ ok: false, error: { code: 'recall/re-register' } });
  t.mock.timers.tick(5000); await settle();
  assert.equal(opens, 3, 'one immediate registration retry per failure cycle');
  reporter.dispose();
  t.mock.timers.tick(120_000); await settle();
  assert.equal(opens, 3);
});

test('reconnect aborts in-flight work, ignores late responses and samples anew', async t => {
  let state = active('A');
  const calls = [], sent = [];
  const remote = {
    openPage: (request, signal) => new Promise(resolve => calls.push({ request, signal, resolve })),
    reportView: async report => { sent.push(report); return ok({ hostEpoch: report.hostEpoch, accepted: true, reason: 'accepted' }); },
  };
  const reporter = new PageReporter('page', remote, () => state);
  t.after(() => reporter.dispose());
  reporter.request();
  state = active('B'); reporter.reconnect();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(ok({ hostEpoch: 'old', registrationId: 'old' }));
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(calls[1].request.sessionId, 'B');
  assert.equal(calls[1].request.registrationSequence, 2);
  calls[1].resolve(ok({ hostEpoch: 'new', registrationId: 'new' }));
  await settle();
  assert.equal(sent[0].view.sessionId, 'B');
  assert.equal(sent[0].hostEpoch, 'new');
});

test('RPC timeout and unload abort native call signals without a retry storm', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const signals = [];
  const remote = {
    openPage: (_request, signal) => new Promise((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    reportView: async () => { throw new Error('Unregistered report'); },
  };
  const reporter = new PageReporter('page', remote, () => active('A'));
  reporter.request();
  t.mock.timers.tick(5000); await settle();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals.length, 2, 'at most the coalesced heartbeat retries');
  reporter.dispose();
  await settle();
  assert.equal(signals[1].aborted, true);
  t.mock.timers.tick(60_000); await settle();
  assert.equal(signals.length, 2);
});

test('in-flight coalescing keeps real activation edges even when the final SessionId is unchanged', async t => {
  let state = active('A'), finish;
  const sent = [];
  const reporter = new PageReporter('page', {
    openPage: async () => ok({ hostEpoch: 'epoch', registrationId: 'token' }),
    reportView: report => {
      sent.push(report);
      if (sent.length === 1) return new Promise(resolve => { finish = resolve; });
      return Promise.resolve(ok({ hostEpoch: 'epoch', accepted: true, reason: 'accepted' }));
    },
  }, () => state);
  t.after(() => reporter.dispose());
  reporter.request(); await settle();
  state = active('B'); reporter.request();
  state = active('A'); reporter.request();
  finish(ok({ hostEpoch: 'epoch', accepted: true, reason: 'accepted' }));
  await settle();
  assert.deepEqual(sent.map(r => [r.view.sessionId, r.activationSequence]), [['A', 1], ['A', 3]]);
  reporter.request(); await settle();
  assert.equal(sent.at(-1).activationSequence, 3, 'unchanged reports do not activate');
  reporter.reconnect(); await settle();
  assert.equal(sent.at(-1).activationSequence, 3, 're-registration preserves the page counter');
});
