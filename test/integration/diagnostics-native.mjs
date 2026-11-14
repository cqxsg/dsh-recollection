import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DIAGNOSTIC_TOOL_NAME as name } from '../../lib/index.js';

const deferred = () => Promise.withResolvers();
const immediate = () => new Promise(resolve => setImmediate(resolve));
function replace(object, method, value) {
  const original = Object.getOwnPropertyDescriptor(object, method);
  Object.defineProperty(object, method, { configurable: true, value });
  return () => original ? Object.defineProperty(object, method, original) : Reflect.deleteProperty(object, method);
}
function failed(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.error.info.code, code, JSON.stringify(result));
  assert.equal(result.value, undefined);
  assert.equal(result.content[0].type, 'text');
}
const released = lease => assert.throws(() => lease.retain(), /disposed/);

export async function verifyDiagnosticTools(ctx, browserBase) {
  assert.ok(ctx.recallDiagnostics);
  const evidence = { node: process.version, dsh: '0.2.1-rc.4', cases: [], results: [], timeoutMs: ctx.tools.get(name).timeoutMs };
  const check = async (label, run) => { await run(); evidence.cases.push(label); console.log(`PASS: ${label}`); };
  const ids = { a: 'diagnostic-a', b: 'diagnostic-b' };
  for (const [label, id] of Object.entries(ids)) {
    await ctx.sessionController.create({ sessionId: id, cwd: process.cwd() });
    await ctx.sessionController.rename({ sessionId: id, title: `Diagnostic fixture ${label.toUpperCase()}` });
    const session = ctx.agents.get(id).session;
    for (let turn = 1; turn <= (label === 'a' ? 1 : 5); turn++) {
      session.append('turn/start', { turn });
      session.append('turn/end', { turn, reason: { kind: 'completed' } });
    }
    const turn = label === 'a' ? 2 : 6;
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step: 1 });
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Diagnostic ${label}` }] }), { surfaceOp: 'append' });
    await ctx.sessions.flush(session);
  }
  const a = ctx.agents.get(ids.a), b = ctx.agents.get(ids.b);
  assert.ok(a && b && a !== b, 'two actual native agents');
  const rawObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
  const calls = new AsyncLocalStorage();
  const leases = [];
  const reads = [];
  const observe = async (id, options) => {
    reads.push({ id, signal: options.signal });
    const lease = await rawObserve(id, options); leases.push(lease); return lease;
  };
  // The Web page owns separate native observations. Trace/inject only the
  // diagnostic execution's async scope, never those unrelated UI leases.
  const intercept = handler => replace(ctx.sessionQuery, 'observeSession', (id, options) => calls.getStore() ? handler(id, options) : rawObserve(id, options));
  const restoreTrace = intercept(observe);
  const stages = new Map();
  const finalResults = new Map();
  const record = (exec, stage) => {
    if (exec.name !== name) return;
    const seen = stages.get(exec.callId) ?? [];
    seen.push(stage); stages.set(exec.callId, seen);
  };
  const offs = [
    ctx.on('tools/pre-execute', async (exec, next) => { record(exec, 'pre'); return next(); }),
    ctx.on('tools/execute', async (exec, next) => { record(exec, 'around'); return next(); }),
    ctx.on('tools/post-execute', async (exec, result, next) => { record(exec, 'post'); return next(); }),
    ctx.on('tools/result', (exec, result) => {
      if (exec.name !== name) return;
      record(exec, 'result');
      finalResults.set(exec.callId, result);
      evidence.results.push({ callId: exec.callId, sessionId: exec.agent?.session.id, code: result.isError ? result.error.info?.code ?? 'UNCLASSIFIED_ERROR' : 'OK' });
    }),
  ];
  let serial = 0;
  const invoke = async (agent, { signal = new AbortController().signal, args = {}, callId = `diagnostic-call-${++serial}` } = {}) => {
    if (agent) agent.session.append('tool/call', { turn: agent === a ? 2 : 6, step: 1, callId, name, arguments: JSON.stringify(args) });
    const result = await calls.run(callId, () => ctx.tools.execute({ name, callId, arguments: args, signal, ...(agent ? { agent } : {}) }));
    assert.equal(finalResults.get(callId), result, 'tools/result observes the returned outcome');
    assert.equal(Object.isFrozen(result), true);
    return result;
  };
  const success = (result, id) => {
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(Object.keys(result.value).sort(), ['cursor', 'eventCount', 'inheritedEventCount', 'sessionId', 'source']);
    assert.equal(result.value.sessionId, id); assert.equal(result.value.source, 'live');
    assert.equal(result.value.eventCount, result.value.cursor + 1);
    assert.deepEqual(JSON.parse(result.content[0].text), result.value, 'native canonical output renderer');
    assert.ok(Object.isFrozen(result.value));
    return result.value;
  };
  let browser;
  try {
    await check('explicit diagnostic registration, native pre/around/post/result pipeline and metadata rendering', async () => {
      const schema = ctx.tools.schemas(a).find(tool => tool.name === name);
      assert.ok(schema); assert.deepEqual(schema.parameters.properties, {});
      assert.equal('timeoutMs' in schema, false, 'timeout is not model-controlled');
      assert.equal(ctx.tools.get(name, a).presentCall({}).card, 'generic');
      success(await invoke(a, { callId: 'pipeline-success' }), ids.a);
      assert.deepEqual(stages.get('pipeline-success'), ['pre', 'around', 'post', 'result']);
      released(leases.at(-1));
    });

    if (browserBase) {
      const { openDiagnosticBrowser } = await import('./diagnostics-browser.mjs');
      browser = await openDiagnosticBrowser(ctx, browserBase, ids);
      await check('real Web switches A to B while an A tool waits; native execution still reads A', async () => {
        const entered = deferred(); const release = deferred();
        const restore = intercept(async (id, options) => {
          entered.resolve(id); await release.promise; return observe(id, options);
        });
        try {
          const pending = a.runMaintenance(signal => invoke(a, { signal, callId: 'browser-background-a' }));
          assert.equal(await entered.promise, ids.a);
          await browser.select(ids.b);
          assert.equal(browser.state().view.sessionId, ids.b);
          release.resolve(); success(await pending, ids.a);
          success(await invoke(b, { callId: 'browser-current-b' }), ids.b);
          evidence.browser = await browser.finish();
        } finally { release.resolve(); restore(); }
      });
    }

    await check('agent-less calls and model SessionId overrides reject before history access', async () => {
      const before = reads.length;
      failed(await invoke(undefined), 'RECALL_DIAGNOSTIC_NO_AGENT');
      const invalid = await invoke(a, { args: { sessionId: ids.b } });
      failed(invalid, 'INVALID_ARGS'); assert.equal(invalid.error.info.name, 'ToolArgsError');
      assert.equal(reads.length, before);
    });

    await check('concurrent actual A/B agents keep independent observations and results', async () => {
      const arrived = deferred(); const release = deferred(); let count = 0;
      const restore = intercept(async (id, options) => {
        if (++count === 2) arrived.resolve(); await release.promise; return observe(id, options);
      });
      try {
        const left = invoke(a), right = invoke(b);
        await arrived.promise; release.resolve();
        const [resultA, resultB] = await Promise.all([left, right]);
        const cutA = success(resultA, ids.a), cutB = success(resultB, ids.b);
        assert.notEqual(cutA.eventCount, cutB.eventCount);
        leases.forEach(released);
      } finally { release.resolve(); restore(); }
    });

    await check('cancellation before dispatch and while native pre-policy waits skips the body', async () => {
      const before = reads.length;
      const cancelled = new AbortController(); cancelled.abort();
      failed(await invoke(a, { signal: cancelled.signal }), 'ABORTED_BEFORE_DISPATCH');
      const controller = new AbortController(); const entered = deferred();
      const off = ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.callId !== 'pre-cancel') return next();
        entered.resolve();
        await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }));
        return next();
      });
      try {
        const pending = invoke(a, { callId: 'pre-cancel', signal: controller.signal });
        await entered.promise; controller.abort(); failed(await pending, 'ABORTED_BEFORE_DISPATCH');
        assert.equal(reads.length, before);
      } finally { controller.abort(); await off(); }
    });

    await check('cancellation during acquisition drains native source work before returning', async () => {
      const entered = deferred(); const release = deferred(); let settled = false;
      const controller = new AbortController(); let nativeSignal;
      const before = leases.length;
      const restore = intercept(async (id, options) => {
        nativeSignal = options.signal; entered.resolve(); await release.promise; return observe(id, options);
      });
      try {
        const pending = invoke(a, { signal: controller.signal }).then(result => { settled = true; return result; });
        await entered.promise; controller.abort(); await immediate();
        assert.equal(nativeSignal.aborted, true); assert.equal(settled, false);
        release.resolve(); failed(await pending, 'ABORTED'); assert.equal(leases.length, before);
      } finally { release.resolve(); restore(); }
    });

    await check('cancelled late native lease is drained and disposed before tool settlement', async () => {
      const acquired = deferred(); const release = deferred(); let settled = false;
      const controller = new AbortController();
      const restore = intercept(async (id, options) => {
        const lease = await observe(id, options); acquired.resolve(lease); await release.promise; return lease;
      });
      try {
        const pending = invoke(a, { signal: controller.signal }).then(result => { settled = true; return result; });
        const lease = await acquired.promise; controller.abort(); await immediate();
        assert.equal(settled, false); release.resolve(); failed(await pending, 'ABORTED'); released(lease);
      } finally { release.resolve(); restore(); }
    });

    await check('cancellation at the native event-read boundary releases the acquired lease', async () => {
      const controller = new AbortController(); let readEvents = false;
      const restore = intercept(async (id, options) => {
        const lease = await observe(id, options);
        return new Proxy(lease, { get(target, key) {
          if (key === 'events') { readEvents = true; controller.abort(); }
          return Reflect.get(target, key, target);
        } });
      });
      try {
        failed(await invoke(a, { signal: controller.signal }), 'ABORTED');
        assert.equal(readEvents, true); released(leases.at(-1));
      } finally { restore(); }
    });

    await check('history identity errors reach the native tool result without a success payload', async () => {
      const restore = intercept((_, options) => observe(ids.b, options));
      try {
        const result = await invoke(a);
        failed(result, 'recall/history-inconsistent');
        assert.match(result.content[0].text, /identity|inconsistent/);
        released(leases.at(-1));
      } finally { restore(); }
    });

    await check('native deadline policy aborts and drains the tool, then returns TOOL_TIMEOUT', async () => {
      assert.ok([...ctx.loader.entries()].some(entry => entry.options.id === 'timeout-policy'));
      const observed = deferred();
      const restore = intercept(async (id, options) => {
        observed.resolve(options.signal);
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        return observe(id, options);
      });
      const before = leases.length;
      const start = performance.now();
      try {
        const pending = invoke(a, { callId: 'native-timeout' });
        const signal = await observed.promise;
        const result = await pending;
        failed(result, 'TOOL_TIMEOUT'); assert.equal(signal.aborted, true);
        evidence.timeoutElapsedMs = performance.now() - start;
        assert.ok(evidence.timeoutElapsedMs >= evidence.timeoutMs - 50);
        assert.equal(leases.length, before);
      } finally { restore(); }
    });

    await check('caller cancellation after successful body replaces the accepted result with ABORTED', async () => {
      const controller = new AbortController(); let sawSuccess = false;
      const off = ctx.on('tools/post-execute', async (exec, result, next) => {
        if (exec.callId === 'post-cancel') { sawSuccess = !result.isError; controller.abort(); }
        return next();
      });
      try {
        failed(await invoke(a, { callId: 'post-cancel', signal: controller.signal }), 'ABORTED');
        assert.equal(sawSuccess, true); released(leases.at(-1));
      } finally { await off(); }
    });

    await browser?.close(); browser = undefined;
    await check('whole plugin reload cancels and drains active diagnostics before re-registering', async () => {
      const acquired = deferred(); const release = deferred(); let sourceSignal, callSettled = false, reloaded = false;
      const restore = intercept(async (id, options) => {
        sourceSignal = options.signal;
        const lease = await observe(id, options); acquired.resolve(lease); await release.promise; return lease;
      });
      try {
        const old = ctx.recallDiagnostics;
        const pending = invoke(a).then(result => { callSettled = true; return result; });
        const lease = await acquired.promise;
        const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'recall');
        const restarting = entry.fiber.restart().then(() => { reloaded = true; });
        await immediate();
        assert.equal(sourceSignal.aborted, true); assert.equal(callSettled, false); assert.equal(reloaded, false);
        release.resolve(); failed(await pending, 'ABORTED'); await restarting; released(lease);
        assert.notEqual(ctx.recallDiagnostics, old);
      } finally { release.resolve(); restore(); }
      success(await invoke(a), ids.a); leases.forEach(released);
    });
    evidence.observationCount = leases.length;
    const output = join(process.env.DSH_HOME, '..', 'diagnostics-evidence.json');
    await writeFile(output, JSON.stringify(evidence, null, 2));
    console.log(`Diagnostic tool evidence: ${output}`);
  } finally {
    await browser?.close(); restoreTrace();
    for (const off of offs) await off();
  }
}
