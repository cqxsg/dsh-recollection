import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DIAGNOSTIC_TOOL_NAME as name, currentInteraction, diagnosticLedgerSpec, diagnosticLedgerRecord, interactionKey } from '../../lib/index.js';
import { scriptedModel, human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { deferred, immediate, replace } from '../../support/fixtures/control.mjs';
import { failed, interceptLedgerWrites, waitForDiagnostics } from '../fixtures/diagnostics.mjs';

const recordFor = (ctx, id) => ctx.recallLedger.records().filter(r => r.sessionId === id);
const callFor = (ctx, id, callId) => recordFor(ctx, id).flatMap(r => r.calls).find(c => c.callId === callId);
const invoke = (ctx, agent, callId, extra = {}) => ctx.tools.execute({ name, callId, arguments: {}, signal: new AbortController().signal, agent, ...extra });
const successful = data => assert.equal(data?.message.isError, false, JSON.stringify(data));

export async function verifyLedger(ctx) {
  await waitForDiagnostics(ctx);
  const evidence = { dsh: '0.2.1-rc.4', node: process.version, pid: process.pid, cases: [], order: [] };
  const check = async (label, task) => { await task(); evidence.cases.push(label); console.log(`PASS: ${label}`); };
  const model = scriptedModel(ctx);
  const { agent, dispose } = await ctx.agents.create({ sessionId: 'ledger-inputs', agentOptions: model.options, meta: { cwd: process.cwd() } });
  let actionCount = 0;
  const observe = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
  let actionHook = async () => {};
  const restoreHistory = replace(ctx.recallHistory, 'withSnapshot', async (...args) => {
    actionCount++;
    evidence.order.push('action');
    await actionHook();
    return observe(...args);
  });
  const off = ctx.on('domain/changed', change => { if (change.domain === diagnosticLedgerSpec.name) evidence.order.push(change.value.calls.at(-1).state); });
  const events = [];
  const stopEvents = ctx.on('session/event', (session, event) => {
    if (session.id === agent.id && ['agent/inbox/spliced', 'turn/start', 'step/start', 'user/message', 'tool/call', 'tool/result'].includes(event.type)) {
      events.push({ seq: event.seq, type: event.type, messageId: event.type === 'user/message' ? event.data.id : undefined });
    }
  });
  try {
    await check('queued input allocates nothing; admitted input and running steering share one interaction; queued followup starts the next', async () => {
      const parked = deferred();
      const maintenance = agent.runMaintenance(() => parked.promise);
      const first = human('ordinary'), steer = human('running supplement'), queued = human('next interaction');
      const arrived = deferred(), release = deferred();
      actionHook = async () => { actionHook = async () => {}; arrived.resolve(); await release.promise; };
      model.replies.push({ calls: ['ordinary'] }, { calls: ['steered'] }, {}, { calls: ['queued'] }, {});
      agent.followup(first);
      assert.equal(currentInteraction(agent.session), undefined);
      assert.deepEqual(recordFor(ctx, agent.id), []);
      parked.resolve(); await maintenance;
      await arrived.promise;
      assert.equal(currentInteraction(agent.session).interactionId, first.id);
      assert.deepEqual(evidence.order.slice(0, 2), ['reserved', 'action']);
      agent.steer(steer); agent.followup(queued);
      assert.equal(currentInteraction(agent.session).interactionId, first.id);
      assert.equal(recordFor(ctx, agent.id).length, 1);
      release.resolve(); await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      assert.equal(model.replies.length, 0);
      const rows = recordFor(ctx, agent.id);
      assert.deepEqual(rows.map(r => [r.interactionId, r.calls.map(c => c.callId)]), [[first.id, ['ordinary', 'steered']], [queued.id, ['queued']]]);
      assert.ok(rows.flatMap(r => r.calls).every(c => c.state === 'completed'));
      evidence.inputs = { first: first.id, steer: steer.id, queued: queued.id };
    });

    await check('idle steer and explicit continue create new interactions; system continuation and request retry retain ownership', async () => {
      const idle = human('idle steer');
      (await model.drive(agent, idle, ['idle-steer'], 'steer')).forEach(successful);
      assert.equal(currentInteraction(agent.session).interactionId, idle.id);
      const next = human('继续');
      (await model.drive(agent, next, ['explicit-continue'])).forEach(successful);
      const before = recordFor(ctx, agent.id).length;
      (await model.drive(agent, recovery(), ['system-continue'])).forEach(successful);
      assert.equal(recordFor(ctx, agent.id).length, before);
      assert.equal(currentInteraction(agent.session).interactionId, next.id);
      let retries = 0;
      const retryOff = agent.ctx.on('agent/request-error', async (_, nextHandler) => ++retries === 1 ? { kind: 'retry' } : nextHandler());
      model.replies.push({ error: true }, { calls: ['request-retry'] }, {});
      agent.followup(recovery()); await agent.whenIdle(); await retryOff();
      assert.equal(retries, 1); assert.equal(model.replies.length, 0);
      assert.equal(callFor(ctx, agent.id, 'request-retry').state, 'completed');
      assert.equal(recordFor(ctx, agent.id).length, before);
      assert.equal(currentInteraction(agent.session).interactionId, next.id);
    });

    await check('rejected pre-step input never establishes an interaction', async () => {
      const old = currentInteraction(agent.session);
      const reject = agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }));
      agent.followup(human('rejected before admission')); await agent.whenIdle(); await reject();
      assert.deepEqual(currentInteraction(agent.session), old);
    });

    await check('identical tool and arguments with different native calls reserve separately; concurrent replay runs no second action', async () => {
      const arrived = deferred(), release = deferred();
      let arrivals = 0;
      actionHook = async () => { if (++arrivals === 2) arrived.resolve(); await release.promise; };
      const pending = model.drive(agent, human('parallel'), ['parallel-a', 'parallel-b']);
      await arrived.promise;
      const before = actionCount;
      try {
        failed(await invoke(ctx, agent, 'parallel-a'), 'RECALL_CALL_REPLAY');
        assert.equal(actionCount, before);
      } finally { release.resolve(); }
      await pending; actionHook = async () => {};
      const row = recordFor(ctx, agent.id).at(-1);
      assert.equal(row.calls.length, 2); assert.equal(row.revision, 4);
      assert.equal(row.calls[0].argsHash, row.calls[1].argsHash);
      assert.notEqual(row.calls[0].eventSeq, row.calls[1].eventSeq);
      const complete = actionCount;
      failed(await invoke(ctx, agent, 'parallel-a'), 'RECALL_CALL_REPLAY');
      assert.equal(actionCount, complete);
      failed(await invoke(ctx, agent, 'missing-call'), 'RECALL_IDENTITY_UNVERIFIED');
    });

    await check('unattributed system input, reused callId and missing native durability fail before authorization', async () => {
      const child = await ctx.agents.create({ sessionId: 'ledger-no-user', agentOptions: model.options, meta: { cwd: process.cwd() } });
      try {
        const [noUser] = await model.drive(child.agent, recovery(), ['no-user']);
        assert.equal(noUser.error.code, 'RECALL_IDENTITY_UNVERIFIED');
        assert.deepEqual(recordFor(ctx, child.agent.id), []);
      } finally { await child.dispose(); }
      const previous = actionCount;
      const [ambiguous] = await model.drive(agent, human('a provider reused its old call id'), ['parallel-a']);
      assert.equal(ambiguous.error.code, 'RECALL_IDENTITY_UNVERIFIED');
      assert.equal(actionCount, previous);
      const flush = replace(ctx.sessions, 'flush', async () => false);
      try {
        const [noPersistence] = await model.drive(agent, human('no durable provenance'), ['no-persistence']);
        assert.equal(noPersistence.error.code, 'RECALL_PROVENANCE_WRITE_FAILED');
        assert.equal(callFor(ctx, agent.id, 'no-persistence'), undefined);
        assert.equal(actionCount, previous);
      } finally { flush(); }
      await ctx.sessions.flush(agent.session);
    });

    await check('parallel calls may reach reservation in a different order from their native log events', async () => {
      const release = deferred();
      const gate = ctx.on('tools/execute', async (exec, next) => {
        if (exec.callId === 'reordered-a') await release.promise;
        return next();
      });
      const notice = ctx.on('domain/changed', change => {
        if (change.domain === diagnosticLedgerSpec.name && change.value.calls.some(c => c.callId === 'reordered-b')) release.resolve();
      });
      try {
        (await model.drive(agent, human('reverse scheduling'), ['reordered-a', 'reordered-b'])).forEach(successful);
        const row = recordFor(ctx, agent.id).at(-1);
        assert.deepEqual(row.calls.map(c => c.callId), ['reordered-b', 'reordered-a']);
        assert.equal(row.revision, 4);
      } finally { release.resolve(); await gate(); await notice(); }
    });

    await check('reservation write failure leaves native memory unchanged and prevents the history action', async () => {
      let fail = true;
      await interceptLedgerWrites(ctx, async (value, next) => {
        if (fail && value.calls.some(c => c.callId === 'write-failed')) { fail = false; throw Object.assign(new Error('Injected backend EIO'), { code: 'EIO' }); }
        return next();
      });
      const previous = actionCount;
      // Reload replaced history service too: install a fresh observable boundary.
      let actions = 0;
      const native = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
      const undo = replace(ctx.recallHistory, 'withSnapshot', (...args) => { actions++; return native(...args); });
      try {
        const [result] = await model.drive(agent, human('write fault'), ['write-failed']);
        assert.equal(result.error.code, 'RECALL_LEDGER_WRITE_FAILED');
        assert.equal(callFor(ctx, agent.id, 'write-failed'), undefined);
        assert.equal(actions, 0); assert.equal(actionCount, previous);
        // The loop has already committed a result. Missing accounting cannot
        // be repaired by inferring authorization from that result's text.
        failed(await invoke(ctx, agent, 'write-failed'), 'RECALL_LEDGER_MISSING');
        assert.equal(actions, 0);
        (await model.drive(agent, human('new interaction after write fault'), ['after-write-fault'])).forEach(successful);
        assert.equal(actions, 1);
      } finally { undo(); }
    });

    await check('cancellation while an uncancellable native write is pending waits and leaves its durable reservation', async () => {
      const entered = deferred(), release = deferred();
      await interceptLedgerWrites(ctx, async (value, next) => {
        if (value.calls.at(-1).callId === 'write-cancel' && value.calls.at(-1).state === 'reserved') { entered.resolve(); await release.promise; }
        return next();
      });
      model.replies.push({ calls: ['write-cancel'] });
      agent.followup(human('cancel write'));
      const pending = agent.whenIdle();
      await entered.promise; agent.cancel({ kind: 'user' });
      let settled = false; void agent.whenIdle().then(() => { settled = true; });
      await immediate(); assert.equal(settled, false);
      release.resolve();
      // The planned final model response is not dispatched after cancellation.
      await pending; assert.equal(model.replies.length, 0);
      assert.equal(callFor(ctx, agent.id, 'write-cancel').state, 'reserved');
      failed(await invoke(ctx, agent, 'write-cancel'), 'RECALL_CALL_REPLAY');
    });

    await check('completion failure retains the earlier reservation and cannot grant a replay', async () => {
      await interceptLedgerWrites(ctx, async (value, next) => {
        if (value.calls.some(c => c.callId === 'completion-failed' && c.state === 'completed')) throw new Error('Injected completion write failure');
        return next();
      });
      const [result] = await model.drive(agent, human('completion fault'), ['completion-failed']);
      assert.equal(result.error.code, 'RECALL_LEDGER_WRITE_FAILED');
      assert.equal(callFor(ctx, agent.id, 'completion-failed').state, 'reserved');
      failed(await invoke(ctx, agent, 'completion-failed'), 'RECALL_CALL_REPLAY');
    });

    await check('plugin reload preserves original records; another domain with the same key stays isolated', async () => {
      const before = ctx.recallLedger.records();
      const neighborSpec = defineDomain({ name: 'recall_validation_neighbor', version: 1, tables: { interactions: domainTable(z.string()) } });
      const neighbor = await ctx.storageDomain.open(neighborSpec);
      const key = interactionKey(before[0]);
      await neighbor.table('interactions').put(key, 'neighbor'); await neighbor.close();
      await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
      await waitForDiagnostics(ctx);
      assert.deepEqual(ctx.recallLedger.records(), before);
      failed(await invoke(ctx, agent, 'ordinary'), 'RECALL_CALL_REPLAY');
      const reopened = await ctx.storageDomain.open(neighborSpec);
      assert.equal(reopened.table('interactions').get(key), 'neighbor'); await reopened.close();
      await assert.rejects(ctx.storageDomain.open({ ...neighborSpec, version: 2 }), { code: 'version-mismatch' });
      await assert.rejects(ctx.storageDomain.open({ ...neighborSpec, tables: { interactions: domainTable(diagnosticLedgerRecord) } }), { code: 'invalid-record' });
    });

    await check('a missing authoritative record cannot silently refill a recovered interaction', async () => {
      const row = recordFor(ctx, agent.id).at(-1);
      await ctx.storageDomain.get(diagnosticLedgerSpec.name).table('interactions').delete(interactionKey(row));
      await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
      await waitForDiagnostics(ctx);
      failed(await invoke(ctx, agent, 'completion-failed'), 'RECALL_LEDGER_MISSING');
      const [continued] = await model.drive(agent, recovery(), ['missing-ledger-new-call']);
      assert.equal(continued.error.code, 'RECALL_LEDGER_MISSING');
      assert.equal(recordFor(ctx, agent.id).some(r => r.interactionId === row.interactionId), false);
    });

    await check('nested dispatch uses native PTC start identity, not its process-local token', async () => {
      // The native PTC implementation emits these public events at bridge start.
      // This transport fixture exercises the identical nested ToolRuntime path
      // without launching a Python runtime or pretending to test that runtime.
      const unreg = ctx.tools.register(defineTool({ name: 'recall_fixture_transport', description: 'test transport', parameters: {},
        output: { schema: { type: 'boolean' }, render: (_, value) => [{ type: 'text', text: String(value) }] },
        execute: async (_, exec) => {
        const data = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId: `${exec.callId}:ptc:1`, name, arguments: {} };
        exec.agent.session.append('tool/ptc-dispatch-start', data);
        const result = await invoke(ctx, exec.agent, data.subCallId, { rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal });
        exec.agent.session.append('tool/ptc-dispatch', { ...data, content: result.content, isError: result.isError });
        assert.equal(result.isError, false, JSON.stringify(result));
        return true;
      } }));
      model.replies.push({ calls: ['ptc-root'], name: 'recall_fixture_transport' }, {});
      agent.followup(human('nested diagnostic')); await agent.whenIdle(); await unreg();
      const item = callFor(ctx, agent.id, 'ptc-root:ptc:1');
      assert.equal(item.kind, 'ptc'); assert.equal(item.rootCallId, 'ptc-root'); assert.equal(item.state, 'completed');
    });
    evidence.events = events;
    evidence.records = ctx.recallLedger.records();
    await writeFile(join(process.env.DSH_HOME, '..', 'ledger-evidence.json'), JSON.stringify(evidence, null, 2));
  } finally { restoreHistory(); await off(); await stopEvents(); await dispose(); await model.dispose(); }
}

export async function crashLedger(ctx, phase) {
  await waitForDiagnostics(ctx);
  const model = scriptedModel(ctx);
  const id = `crash-${phase}`;
  const { agent } = await ctx.agents.create({ sessionId: id, agentOptions: model.options, meta: { cwd: process.cwd() } });
  let actions = 0;
  await interceptLedgerWrites(ctx, async (value, next) => {
    if (value.sessionId !== id) return next();
    const call = value.calls.at(-1);
    if (phase === 'reserved' && call.state === 'reserved') {
      await next();
      process.send({ checkpoint: phase, pid: process.pid, id, callId: call.callId, actions });
      await new Promise(() => {});
    } else if (phase === 'completed' && call.state === 'completed') {
      process.send({ checkpoint: phase, pid: process.pid, id, callId: call.callId, actions });
      await new Promise(() => {});
    } else return next();
  });
  const raw = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
  replace(ctx.recallHistory, 'withSnapshot', (...args) => { actions++; return raw(...args); });
  await model.drive(agent, human(`crash ${phase}`), [`${phase}-call`]);
  assert.fail('parent must terminate this process before completion');
}

export async function recoverLedger(ctx, phase) {
  await waitForDiagnostics(ctx);
  const model = scriptedModel(ctx);
  const id = `crash-${phase}`, callId = `${phase}-call`;
  const stored = structuredClone(recordFor(ctx, id));
  assert.equal(stored.length, 1); assert.equal(stored[0].calls[0].state, 'reserved');
  const { agent, dispose } = await ctx.agents.resume({ resumeSessionId: id, agentOptions: model.options });
  try {
    assert.deepEqual(recordFor(ctx, id), stored);
    assert.equal(currentInteraction(agent.session).interactionId, stored[0].interactionId);
    const closer = agent.session.snapshotEvents().find(e => e.type === 'turn/end' && e.data.reason.kind === 'interrupted');
    assert.ok(closer, 'native interrupted-turn closers');
    failed(await invoke(ctx, agent, callId), 'RECALL_CALL_REPLAY');
    (await model.drive(agent, recovery(), [`recovered-${phase}`])).forEach(successful);
    assert.equal(recordFor(ctx, id).length, 1, 'system wake inherits the original interaction across a new turn');
    assert.equal(recordFor(ctx, id)[0].interactionId, stored[0].interactionId);
    const fresh = human('继续');
    (await model.drive(agent, fresh, [`fresh-${phase}`])).forEach(successful);
    assert.equal(recordFor(ctx, id).length, 2);
    assert.equal(recordFor(ctx, id)[1].interactionId, fresh.id);
    await writeFile(join(process.env.DSH_HOME, '..', `recovered-${phase}.json`), JSON.stringify({ pid: process.pid, phase, closer, records: recordFor(ctx, id) }, null, 2));
    console.log(`PASS: independent process recovery of ${phase}, native closers, replay refusal, system continuation and explicit new input`);
  } finally { await dispose(); await model.dispose(); }
}
