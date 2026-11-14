import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { RecallPreparationService } from '../../lib/index.js';
import { RecallHostService } from '../../lib/prewarm.js';
import { rangeFixture } from '../../support/fixtures/range.mjs';

async function until(predicate, label, timeout = 15_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

const view = sessionId => ({ sessionId, selection: sessionId ? 'selected' : 'none', conversationVisible: true, visible: true, focused: true, closed: false });

async function naturalFocus(context, page) {
  // Playwright otherwise forces EVERY tab focused/visible, hiding real tab
  // transitions. Disable its default emulation; leave Chrome's events intact.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await cdp.detach();
}

async function verifyGateway(ctx, a, b) {
  const alice = new Peer(ctx, { principal: { kind: 'recall-test', id: 'alice' } });
  const bob = new Peer(ctx, { principal: { kind: 'recall-test', id: 'bob' } });
  let allowGlobal = false;
  const unregister = ctx.remoteAccess.registerPolicy('recall-test', {
    bindings: () => [
      { resource: { kind: 'session', id: a }, role: { name: 'recall-selected', resource: 'session', actions: ['recall/openPage', 'recall/reportView'] } },
      ...(allowGlobal ? [{ resource: { kind: 'global' }, role: { name: 'recall-empty', resource: 'global', actions: ['recall/openPage', 'recall/reportView'] } }] : []),
    ],
  });
  const invoke = (method, value, peer = alice) => ctx.typertGateway.invoke({
    namespace: 'recall', method, args: { [method === 'openPage' ? 'request' : 'report']: value }, peer,
  });
  let historyCalls = 0;
  const restores = [];
  // A read or lookup would fail, including any accidental work before receipt.
  for (const [service, method] of [[ctx.sessions, 'get'], [ctx.sessionQuery, 'observeSession'], [ctx.sessionController, 'inspect']]) {
    const descriptor = Object.getOwnPropertyDescriptor(service, method);
    Object.defineProperty(service, method, { configurable: true, value() { historyCalls++; throw new Error('History read during page receipt'); } });
    restores.push(() => descriptor ? Object.defineProperty(service, method, descriptor) : Reflect.deleteProperty(service, method));
  }
  try {
    const start = performance.now();
    const registration = await invoke('openPage', { protocolVersion: 1, pageId: 'authorized-page', registrationSequence: 1, sessionId: a });
    const report = { protocolVersion: 1, pageId: 'authorized-page', ...registration, sequence: 1, activationSequence: 1, view: view(a) };
    assert.equal((await invoke('reportView', report)).accepted, true);
    const receiptMs = performance.now() - start;
    assert.equal(historyCalls, 0);
    assert.ok(receiptMs < 1000);
    await assert.rejects(invoke('openPage', { protocolVersion: 1, pageId: 'denied-page', registrationSequence: 1, sessionId: b }), { code: 'remote-access/denied' });
    await assert.rejects(invoke('reportView', { ...report, sequence: 2, view: view(b) }), { code: 'remote-access/denied' });
    await assert.rejects(invoke('reportView', { ...report, sequence: 2 }, bob), { code: 'recall/re-register' });
    await assert.rejects(invoke('reportView', { ...report, sequence: 2, view: view(null) }), { code: 'remote-access/denied' });
    allowGlobal = true;
    assert.equal((await invoke('reportView', { ...report, sequence: 2, view: view(null) })).accepted, true);
    assert.equal(ctx.recallPages.snapshot().find(p => p.pageId === 'authorized-page').view.sessionId, null);
    await assert.rejects(invoke('reportView', { ...report, protocolVersion: 2 }), error => error.code?.startsWith('gateway/'));
    await assert.rejects(invoke('snapshot', {}), error => error.code?.startsWith('gateway/'));
    await assert.rejects(invoke('reportView', { ...report, sequence: 3, view: { ...view(null), selection: 'selected' } }), { code: 'recall/invalid-report' });
    await invoke('reportView', { ...report, sequence: 3, view: { ...view(null), closed: true } });
    console.log(`PASS: native Gateway codecs, per-session/global authorization, principal isolation, zero history calls; open + receipt ${receiptMs.toFixed(1)}ms.`);
    return receiptMs;
  } finally {
    for (const restore of restores.reverse()) restore();
    unregister();
    await alice.dispose(); await bob.dispose();
  }
}

async function measureBrowserRoundTrips(page, sessionId) {
  const result = await page.evaluate(async sessionId => {
    const remote = window.__recallProbe.remote.recall;
    const pageId = `recall-rtt-${crypto.randomUUID()}`;
    const invoke = (method, value) => remote[method](value, AbortSignal.timeout(5000));
    const started = performance.now();
    const opened = await invoke('openPage', { protocolVersion: 1, pageId, registrationSequence: 1, sessionId });
    if (!opened.ok) throw new Error(`Round-trip registration: ${opened.error.code}`);
    const openMs = performance.now() - started, samplesMs = [];
    const view = { sessionId, selection: 'selected', conversationVisible: false, visible: false, focused: false, closed: false };
    let sequence = 0, closedAccepted = false;
    const report = closed => ({ protocolVersion: 1, pageId, ...opened.value, sequence: ++sequence,
      activationSequence: 0, view: { ...view, closed } });
    try {
      for (let index = 0; index < 20; index++) {
        const at = performance.now(), received = await invoke('reportView', report(false));
        const elapsedMs = performance.now() - at;
        if (!received.ok || !received.value.accepted || received.value.hostEpoch !== opened.value.hostEpoch) {
          throw new Error(`Round-trip report ${index} was not accepted`);
        }
        samplesMs.push(elapsedMs);
      }
    } finally {
      const closed = await invoke('reportView', report(true));
      closedAccepted = closed.ok && closed.value.accepted;
      if (!closedAccepted) throw new Error('Round-trip page did not close');
    }
    return { pageId, openMs, samplesMs, closedAccepted };
  }, sessionId);
  assert.equal(result.samplesMs.length, 20);
  assert.ok(result.samplesMs.every(ms => Number.isFinite(ms) && ms >= 0));
  assert.equal(result.closedAccepted, true);
  const sorted = [...result.samplesMs].sort((a, b) => a - b);
  return { ...result, medianMs: (sorted[9] + sorted[10]) / 2, empiricalP95Ms: sorted[18], maxMs: sorted[19],
    definition: 'Browser performance.now before Remote reportView to accepted reply; real local transport using the existing three-record fixtures and a separate inactive page identity; excludes registration and Playwright transport, not a 10000-record CPU-pressure measurement.' };
}

export async function verifyWeb(ctx, base) {
  const preparationFiber = [...ctx.registry.get(RecallPreparationService).fibers][0], prior = ctx.recallPreparation;
  preparationFiber.update({ batch: { maxRecords: 1 } }, true);
  await until(() => ctx.recallPreparation && ctx.recallPreparation !== prior, 'one-record browser batches');
  await preparationFiber.await();
  const a = (await ctx.sessionController.create({ cwd: process.cwd(), sessionId: 'recall-fixture-a' })).sessionId;
  const b = (await ctx.sessionController.create({ cwd: process.cwd(), sessionId: 'recall-fixture-b' })).sessionId;
  const gateway = (await ctx.sessionController.create({ cwd: process.cwd(), sessionId: 'recall-gateway-fixture' })).sessionId;
  await ctx.sessionController.rename({ sessionId: a, title: 'Recall fixture A' });
  await ctx.sessionController.rename({ sessionId: b, title: 'Recall fixture B' });
  for (const id of [a, b, gateway]) {
    const session = ctx.sessions.get(id);
    const originals = [];
    for (let turn = 1; turn <= 3; turn++) {
      session.append('turn/start', { turn });
      originals.push(session.append('user/message', { id: `message-${id}-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Stored fixture ${id}, turn ${turn}; no model request.` }] }, { surfaceOp: 'append' }).seq);
      session.append('turn/end', { turn, reason: { kind: 'completed' } });
    }
    rangeFixture(session).summary(originals);
    await ctx.sessions.flush(session);
  }
  const originalSeqs = [a, b].map(id => ctx.sessions.get(id).seq);
  const receiptMs = await verifyGateway(ctx, gateway, b);
  assert.equal(ctx.recallPreparation.status(a), undefined, 'A has no demand before its real UI selection');
  let executablePath;
  for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
    try { await access(candidate); executablePath = candidate; break; } catch {}
  }
  if (!executablePath) throw new Error('Browser validation requires installed Chrome or Edge.');
  const browser = await chromium.launch({ executablePath, headless: true });
  // Hold only the first native scope for A/B. Actual browser reports choose the
  // next task while the current batch is in flight; no production test hooks.
  const gates = new Map([a, b].map(id => [id, { entered: false, release: Promise.withResolvers() }]));
  const batchOrder = [];
  const withSnapshot = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
  const descriptor = Object.getOwnPropertyDescriptor(ctx.recallHistory, 'withSnapshot');
  Object.defineProperty(ctx.recallHistory, 'withSnapshot', { configurable: true, value(id, operation, signal, options) {
    return withSnapshot(id, async (cut, scope) => {
      if (gates.has(id)) {
        batchOrder.push(id);
        const gate = gates.get(id);
        if (!gate.entered) { gate.entered = true; await gate.release.promise; }
      }
      return operation(cut, scope);
    }, signal, options);
  } });
  const errors = [];
  const logs = [];
  const requests = [];
  let page;
  try {
    const context = await browser.newContext();
    page = await context.newPage();
    await naturalFocus(context, page);
    page.on('pageerror', error => errors.push(error.stack));
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') logs.push(message.text()); });
    page.on('request', request => { if (request.method() === 'POST') requests.push(request.postData() ?? ''); });
    await page.goto(ctx.connection.authenticatedUrl(base));
    await page.waitForFunction(() => Boolean(window.__recallProbe), undefined, { timeout: 25_000 });
    await page.waitForFunction(() => Boolean(window.__recallProbe?.recallClient), undefined, { timeout: 10_000 });
    let pageId = await page.evaluate(() => window.__recallProbe.recallClient.pageId);
    let page2, page2Id;
    const clientInstances = [];
    const untilPage = (predicate, label, timeout) => until(async () => {
      // Native module/Remote dependency refresh can remount a Client service
      // while the browser page stays open. Follow its public current identity.
      for (const [surface, second] of [[page, false], [page2, true]]) {
        if (!surface || surface.isClosed()) continue;
        const id = await surface.evaluate(() => window.__recallProbe?.recallClient?.pageId);
        const old = second ? page2Id : pageId;
        if (id && id !== old) {
          clientInstances.push({ second, previous: old ?? null, current: id });
          if (second) page2Id = id; else pageId = id;
        }
      }
      return predicate();
    }, label, timeout);
    const state = () => ctx.recallPages.snapshot().find(p => p.pageId === pageId);
    await untilPage(() => state()?.view, 'initial report');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByText('开始使用', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByText('未分组', { exact: true }).click();
    await page.getByText('Recall fixture A', { exact: true }).first().click();
    await untilPage(() => state()?.view?.sessionId === a, 'open existing A');
    await untilPage(() => state()?.active, 'A active');
    await untilPage(() => gates.get(a).entered, 'A automatic preheat started');
    const originalOrder = ctx.recallPreparation.status(a).queueOrder;
    console.log('PASS: real Web Client module, initial snapshot and existing Session selection without prompting.');
    const aOrder = state().activationOrder;
    await page.getByText('Recall fixture B', { exact: true }).first().click();
    await untilPage(() => state()?.view?.sessionId === b && state().active, 'A→B');
    assert.equal(ctx.recallPreparation.status(b).priority, 'current');
    gates.get(a).release.resolve();
    await untilPage(() => gates.get(b).entered, 'B preempted A at batch boundary');
    assert.equal(ctx.recallPreparation.status(a).records, 1);
    assert.equal(ctx.recallPreparation.status(a).queueOrder, originalOrder);
    assert.ok(state().activationOrder > aOrder);
    const bOrder = state().activationOrder;
    await page.getByText('Recall fixture A', { exact: true }).first().click();
    await untilPage(() => state()?.view?.sessionId === a && state().activationOrder > bOrder, 'B→A');
    assert.equal(ctx.recallPreparation.status(a).priority, 'current');
    gates.get(b).release.resolve();
    await untilPage(() => [a, b].every(id => ctx.recallPreparation.status(id)?.state === 'ready'), 'A resumed then B finished');
    assert.deepEqual(batchOrder, [a, b, a, a, b, b]);
    assert.deepEqual([a, b].map(id => ctx.recallPreparation.status(id).records), [3, 3]);
    const preheatedA = ctx.recallPreparation.status(a), schedulingOrder = [...batchOrder];
    console.log('PASS: real Web activation schedules A, B, A, A, B, B with original targets and cached progress.');
    await page.evaluate(() => window.__recallProbe.layout.selectPanel('plugins'));
    await untilPage(() => state()?.view?.conversationVisible === false, 'global panel');
    assert.equal(state().active, false);
    assert.equal(state().view.sessionId, a);
    await page.evaluate(() => window.__recallProbe.layout.selectPanel(null));
    await untilPage(() => state()?.active, 'Conversation panel restored');
    await page.evaluate(id => { window.__overlap = window.__recallProbe.sessions.retain(id, { source: 'mainView' }); }, b);
    await untilPage(() => state()?.view?.selection === 'ambiguous', 'double mainView ownership');
    assert.equal(state().view.sessionId, null);
    assert.equal(state().active, false);
    await page.evaluate(() => { window.__overlap.release(); delete window.__overlap; });
    await untilPage(() => state()?.view?.sessionId === a && state().active, 'overlap resolved');
    await page.evaluate(id => window.__recallProbe.uiWorkspace.archiveSession(id), a);
    await untilPage(() => state()?.view?.selection === 'none', 'empty selection');
    assert.equal(state().view.sessionId, null);
    await page.evaluate(async id => { await window.__recallProbe.uiWorkspace.unarchiveSession(id); window.__recallProbe.uiWorkspace.openSession(id); }, a);
    await untilPage(() => state()?.view?.sessionId === a && state().active, 'selection restored');
    console.log('PASS: real Web A→B→A, global panel, overlapping mainView references and empty selection.');

    // This headless Chrome keeps separate page windows visible even when one
    // loses focus. Exercise hidden->visible explicitly, and label it as a
    // browser-input simulation rather than claiming an OS minimize test.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await untilPage(() => state()?.view?.visible === false, 'simulated hidden state');
    assert.equal(state().active, false);
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await untilPage(() => state()?.view?.visible && state().active, 'visible state restored');

    // Reload only the Client service with A already selected: initial sampling
    // must recover A without another navigation, message, or storage-key read.
    const previousPageId = pageId;
    await page.evaluate(async () => {
      const runtime = [...window.__recallProbe.registry.values()].find(r => r.callback.name === 'RecallClientService');
      await [...runtime.fibers][0].restart();
    });
    await page.waitForFunction(old => window.__recallProbe?.recallClient.pageId !== old, previousPageId);
    pageId = await page.evaluate(() => window.__recallProbe.recallClient.pageId);
    await untilPage(() => state()?.view?.sessionId === a && state().active, 'initial sample after Client reload');
    const oldPage = ctx.recallPages.snapshot().find(p => p.pageId === previousPageId);
    const oldSequence = oldPage.sequence;

    page2 = await context.newPage();
    await naturalFocus(context, page2);
    page2.on('pageerror', error => errors.push(error.stack));
    await page2.goto(base);
    await page2.waitForFunction(() => Boolean(window.__recallProbe));
    await page2.waitForFunction(id => Boolean(window.__recallProbe.sessions.list.getSnapshot().byId[id]), b);
    await page2.evaluate(id => window.__recallProbe.uiWorkspace.openSession(id), b);
    await page2.bringToFront();
    page2Id = await page2.evaluate(() => window.__recallProbe.recallClient.pageId);
    assert.notEqual(pageId, page2Id);
    const state2 = () => ctx.recallPages.snapshot().find(p => p.pageId === page2Id);
    await untilPage(() => state2()?.view?.sessionId === b && state2().active, 'second page active');
    await untilPage(() => state()?.view?.focused === false, 'first page blurred');
    const inactiveOrder = state().activationOrder, inactivePageId = pageId, inactiveSequence = state().sequence;
    // Exercise the same identity transition explicitly in the background, so
    // the polling helper is verified even when native refresh does not occur.
    await page.evaluate(async () => {
      const runtime = [...window.__recallProbe.registry.values()].find(r => r.callback.name === 'RecallClientService');
      await [...runtime.fibers][0].restart();
    });
    await untilPage(() => pageId !== inactivePageId && state()?.view?.focused === false, 'background Client remount');
    const inactiveReceivedAt = state().lastReceivedAt;
    // Sequence numbers restart on a new registration. A heartbeat assertion
    // follows actual receipt time, including a background transport reconnect.
    const heartbeatStarted = performance.now();
    await untilPage(() => state().lastReceivedAt > inactiveReceivedAt, 'unfocused heartbeat', 8000);
    const heartbeatMs = performance.now() - heartbeatStarted;
    assert.equal(state().active, false);
    assert.ok(state().activationOrder <= inactiveOrder, 'background heartbeat or remount cannot reactivate the page');
    assert.equal(ctx.recallPages.snapshot().find(p => p.pageId === inactivePageId).sequence, inactiveSequence, 'old background Client stopped reporting');
    assert.equal(ctx.recallPages.snapshot().find(p => p.pageId === previousPageId).sequence, oldSequence, 'unloaded Client stopped reporting');
    assert.ok(state2().activationOrder > inactiveOrder);
    const visibility = { first: state().view.visible, second: state2().view.visible };
    assert.equal(state2().view.visible, true);
    console.log('PASS: two real pages, focus/visibility, background heartbeat without reactivation and Client reload cleanup.');

    // A pagehide request can be cancelled by a real browser close. Exercise
    // event-to-Remote delivery before closing; expiry is tested on real time below.
    await page2.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await untilPage(() => state2()?.phase === 'closed', 'pagehide receipt');
    await page2.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await untilPage(() => state2()?.phase === 'open' && state2()?.view?.sessionId === b, 'BFCache restore sample');
    await page2.close();
    await page.bringToFront();
    await untilPage(() => state()?.active, 'first page refocused');

    // Physical network failure, not a mocked reset event. No receipt may renew
    // the old lease. Retain B locally while offline, then recover that fresh view.
    const offlineGate = { entered: false, release: Promise.withResolvers() };
    gates.set(a, offlineGate);
    ctx.recallPreparation.warm(a, true);
    await untilPage(() => offlineGate.entered, 'current A target held for offline lifecycle check');
    assert.equal(ctx.recallPreparation.status(a).priority, 'current');
    await context.setOffline(true);
    await page.evaluate(id => window.__recallProbe.uiWorkspace.openSession(id), b);
    const offlineStarted = performance.now();
    await untilPage(() => state()?.phase === 'expired', '60s offline expiry', 70_000);
    assert.equal(state().active, false);
    const priorityAtExpiry = ctx.recallPreparation.status(a).priority;
    assert.equal(priorityAtExpiry, 'current', 'expiry alone retains the existing fixed task');
    const expiryMs = performance.now() - offlineStarted;
    await context.setOffline(false);
    await page.evaluate(() => window.__recallProbe.connection.reconnect());
    await untilPage(() => state()?.phase === 'open' && state()?.view?.sessionId === b && state().active, 'fresh view after network reconnect', 20_000);
    assert.equal(ctx.recallPreparation.status(b).priority, 'current');
    assert.equal(ctx.recallPreparation.status(a).priority, 'background', 'new B activation takes over');
    offlineGate.release.resolve();
    await untilPage(() => [a, b].every(id => ctx.recallPreparation.status(id)?.state === 'ready'), 'offline target and new selection finish');
    console.log(`PASS: physical offline expiry (${expiryMs.toFixed(0)}ms observed), reconnect and fresh B selection.`);

    // Restart only optional Remote; core preparation and ledger stay alive.
    const epochBefore = state() && ctx.recallPages.pages.hostEpoch;
    const pageBeforeHostReload = pageId;
    const preparationEntries = ctx.recallPreparation.entries, memoryBefore = ctx.recallMemory.budget;
    const fiber = [...ctx.registry.get(RecallHostService).fibers][0];
    await fiber.restart();
    assert.notEqual(ctx.recallPages.pages.hostEpoch, epochBefore);
    await untilPage(() => state()?.view?.sessionId === b && state().active, 'Host-only restart re-registration', 12_000);
    await untilPage(() => ctx.recallPreparation?.status(b)?.state === 'ready', 'preheat after Host restart');
    assert.equal(ctx.recallPreparation.entries, preparationEntries, 'Remote restart preserves core preparation');
    assert.equal(ctx.recallMemory.budget, memoryBefore);
    assert.equal(ctx.recallPreparation.status(b).records, 3);
    assert.equal(await page.evaluate(() => window.__recallProbe.recallClient.pageId), pageBeforeHostReload);
    assert.deepEqual([a, b].map(id => ctx.sessions.get(id).seq), originalSeqs, 'no new messages or model turns');
    assert.equal(requests.some(body => /session\/prompt/.test(body)), false);
    assert.deepEqual(errors, []);
    const selectedBeforeMeasurement = state().view.sessionId, activationBeforeMeasurement = state().activationOrder;
    const preparationAtMeasurementStart = ctx.recallPreparation.snapshot().map(({ sessionId, state, records, waiters }) => ({ sessionId, state, records, waiters }));
    const notificationRoundTrips = await measureBrowserRoundTrips(page, b);
    notificationRoundTrips.preparationAtStart = preparationAtMeasurementStart;
    assert.equal(ctx.recallPages.snapshot().find(p => p.pageId === notificationRoundTrips.pageId)?.phase, 'closed');
    assert.equal(state().view.sessionId, selectedBeforeMeasurement);
    assert.equal(state().activationOrder, activationBeforeMeasurement);
    assert.deepEqual(errors, []);
    console.log(`PASS: 20 real browser Remote replies; median ${notificationRoundTrips.medianMs.toFixed(2)}ms, p95 ${notificationRoundTrips.empiricalP95Ms.toFixed(2)}ms; inactive measurement page closed.`);
    console.log('PASS: automatic A/B preheat and Host-only reload restore preparation without a new message/model turn.');
    await page.screenshot({ path: join(process.cwd(), '..', 'browser-success.png'), fullPage: true });
    await writeFile(join(process.cwd(), '..', 'browser-evidence.json'), JSON.stringify({ browser: await browser.version(), executablePath, receiptMs,
      receiptDefinition: 'Host-local Gateway openPage + reportView; excludes the browser and network.', notificationRoundTrips,
      heartbeatMs, expiryMs, priorityAtExpiry, visibility, pageId, page2Id, clientInstances, errors, schedulingOrder, preheatedA, preparedAfterReload: ctx.recallPreparation.status(b), checks: ['existing-session', 'automatic-preheat', 'A-B-A-priority-preemption-resume', 'panel', 'overlap', 'empty', 'simulated-hidden-visible', 'client-reload', 'two-pages', 'background-heartbeat', 'pagehide-pageshow-events', 'offline-expiry-reconnect-task-retention', 'host-only-reload', 'preheat-after-reload', 'no-new-messages', 'browser-remote-round-trips'] }, null, 2));
  } catch (error) {
    console.error('Browser errors:', errors);
    console.error('Browser warnings:', logs.slice(-15));
    console.error('Host pages:', ctx.recallPages.snapshot());
    console.error('Host preparation:', ctx.recallPreparation.snapshot());
    if (page) {
      console.error('Browser state:', await page.evaluate(() => ({
        text: document.body.innerText.slice(-2500),
        probe: Boolean(window.__recallProbe),
        pageId: window.__recallProbe?.recallClient?.pageId,
        failures: window.__recallProbe?.modules?.entries?.state?.getSnapshot(),
      })).catch(() => undefined));
      await page.screenshot({ path: join(process.cwd(), '..', 'browser-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    if (descriptor) Object.defineProperty(ctx.recallHistory, 'withSnapshot', descriptor);
    else Reflect.deleteProperty(ctx.recallHistory, 'withSnapshot');
    await browser.close();
  }
}
