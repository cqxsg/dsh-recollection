import assert from 'node:assert/strict';
import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import { classifyHistoryRange, loadRecallConfig, SEARCH_MATCH_BATCH, startPerformanceCapture } from '../lib/index.js';
import { recallHarness } from '../support/fixtures/recall-harness.mjs';
import { createHistoryFixture } from '../support/fixtures/history.mjs';
import { rangeFixture, text } from '../support/fixtures/range.mjs';
import { human, recovery } from '../support/fixtures/scripted-model.mjs';
import { resourceMeter, digest } from '../support/measurement.mjs';
import { semanticPerformanceResult } from './report.mjs';

async function seed(ctx, id, bodies, attachment) {
  const fixture = await createHistoryFixture(ctx, id, []), f = rangeFixture(fixture.session);
  f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
  f.append('system/message', { turn: 1, step: 1, message: { id: `${id}-system`, role: 'system', source: { kind: 'system-prompt' }, content: [text('You are a helpful assistant.')] } }, { surfaceOp: 'append' });
  bodies.forEach((body, i) => f.user([text(body), ...(i === 0 && attachment ? [{ type: 'file', attachment }] : [])]));
  f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.summary([...fixture.session.surface.nodes].filter(seq => fixture.session.snapshotEvents()[seq].type !== 'system/message'));
  const events = fixture.session.seq; await fixture.flush(); await fixture.close();
  return { events, storedBytes: (await ctx.sessionPersistence.stat(id)).sizeBytes };
}
async function timed(fn) { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; }
const timeoutCode = code => ['business_deadline', 'preparation_timeout', 'TOOL_TIMEOUT', 'TimeoutError'].includes(code);

export async function performanceTrial(ctx, spec, progress = async () => {}) {
  const h = recallHarness(ctx), tools = [], metrics = {}, memoryGrowth = [], stages = [], config = loadRecallConfig();
  const bodies = Array.from({ length: spec.records }, (_, i) => `${i}: ${i === Math.floor(spec.records / 2) ? 'benchmark-hit needle' : 'background-entry'} ` + 'stable history payload '.repeat(90));
  const sourceDigest = digest(bodies);
  const coldId = 'benchmark-cold', currentId = 'benchmark-current';
  let stored, meter, capture, restore = () => {}, closePage = () => {};
  const snapshot = () => ({ mode: spec.mode, records: spec.records, bytesPerBody: Buffer.byteLength(bodies[0]), ...stored, config, matching: SEARCH_MATCH_BATCH,
    sourceDigest, metrics, memoryGrowth, tools, stages, resources: meter?.snapshot(), diagnosticsEnabled: !!spec.diagnostics,
    diagnostics: capture?.snapshot(), semanticDigest: digest(semanticPerformanceResult(tools)),
    coldDefinition: 'native session detached; OS file caches not flushed; first plugin search on live resumed agent',
    timingDefinition: 'tool wall time includes native admission/result plus a zero-cost scripted provider; notification is Host entry, not browser network',
    gcAtMemoryBoundaries: typeof global.gc === 'function' });
  const phase = async name => { stages.push({ name, startedMs: performance.now() }); await progress(name, snapshot); };
  try {
    await phase('fixture');
    stored = await seed(ctx, coldId, bodies); await seed(ctx, currentId, ['current page']);
    global.gc?.(); meter = resourceMeter();
    capture = spec.diagnostics ? startPerformanceCapture({ maxEvents: spec.diagnosticMaxEvents }) : undefined;
    const matcher = ctx.recallTools.search.matcher, originalMatch = matcher.match.bind(matcher);
    restore = () => { matcher.match = originalMatch; };
    let matchMs = 0, matchCalls = 0;
    matcher.match = async (...args) => { const start = performance.now(); try { return await originalMatch(...args); } finally { matchMs += performance.now() - start; matchCalls++; } };
    async function invoke(agent, name, args, input = recovery()) {
      const startMatch = matchMs, startCalls = matchCalls, startedMs = performance.now();
      const measured = await timed(() => h.drive(agent, [{ name, args }], input));
      const native = measured.value[0], value = native.value;
      const row = { name, args, startedMs, finishedMs: performance.now(), elapsedMs: measured.ms, status: value?.status ?? 'native_error', code: value?.code ?? native.data.error?.code,
        matchMs: matchMs - startMatch, matchedRecords: matchCalls - startCalls, estimatedOutputTokens: estimateContent(native.data.message.content),
        outputBytes: Buffer.byteLength(JSON.stringify(native.data.message.content)), value };
      tools.push(row);
      if (value?.status === 'ok') assert.ok(row.estimatedOutputTokens <= (name === 'recall_search' ? 2000 : 4000));
      return row;
    }
    async function prepare(id) {
      const began = performance.now();
      try { const p = await ctx.recallPreparation.wait(id, AbortSignal.timeout(config.prepareMs)); return { ms: performance.now() - began, records: ctx.recallPreparation.records(p).length, status: 'ok' }; }
      catch (error) { if (error.name !== 'TimeoutError') throw error; return { ms: performance.now() - began, status: 'timeout', code: error.name }; }
    }
    const pageId = 'performance-page', registration = ctx.recallHost.openPage({ protocolVersion: 1, pageId, registrationSequence: 1, sessionId: currentId }, new AbortController().signal);
    let sequence = 0, pageClosed = false;
    const report = closed => {
      if (pageClosed) return;
      const receipt = ctx.recallHost.reportView({ protocolVersion: 1, pageId, ...registration, sequence: ++sequence, activationSequence: 1,
        view: { sessionId: currentId, selection: 'selected', conversationVisible: !closed, visible: !closed, focused: !closed, closed } }, new AbortController().signal);
      pageClosed = closed; return receipt;
    };
    closePage = () => report(true);
    await phase('native-cold-read');
    const acquisitionStart = performance.now();
    await ctx.recallHistory.withSnapshot(coldId, snapshot => {
      metrics.nativeColdReadMs = performance.now() - acquisitionStart; metrics.nativeColdSource = snapshot.source;
      let start = performance.now(); foldSurface(snapshot.events, ctx.sessions.messageProjections); metrics.foldMs = performance.now() - start;
      start = performance.now(); classifyHistoryRange(snapshot, ctx.sessions.messageProjections); metrics.classificationMs = performance.now() - start;
    });
    await phase('preparation');
    const due = performance.now() + 5;
    const notify = new Promise((resolve, reject) => setTimeout(async () => {
      try {
        const at = performance.now(), before = ctx.recallPreparation.status(coldId)?.state;
        const receipt = report(false), receiptAt = performance.now(); assert.equal(receipt.accepted, true);
        const ready = await prepare(currentId);
        resolve({ timerDelayMs: Math.max(0, at - due), hostReceiptMs: receiptAt - at, activationToReadyMs: performance.now() - receiptAt,
          duringPreparation: before === 'queued' || before === 'preparing', largeStateAtReceipt: before, ready });
      } catch (error) { reject(error); }
    }, 5));
    [metrics.coldPreparation, metrics.notification] = await Promise.all([prepare(coldId), notify]);
    metrics.preparation = ctx.recallPreparation.status(coldId); report(true);
    if (metrics.coldPreparation.status === 'ok') assert.equal(metrics.coldPreparation.records, spec.records);
    await phase('search-fixture');
    const resumed = await timed(() => h.seed('benchmark-search', bodies));
    const agent = resumed.value.agent; metrics.fixtureAndResumeMs = resumed.ms; metrics.nativeResumeMs = resumed.value.resumeMs;
    await phase('cold-search');
    const cold = await invoke(agent, 'recall_search', { action: 'search', mode: 'literal', patterns: ['benchmark-hit'] }, human('Find benchmark-hit.'));
    metrics.coldPluginSearch = { elapsedMs: cold.elapsedMs, status: cold.status, code: cold.code, matchMs: cold.matchMs, matchedRecords: cold.matchedRecords };
    await phase('hot-search');
    metrics.preparedBeforeHotQuery = ctx.recallPreparation.status(agent.id)?.state === 'ready';
    const hot = await invoke(agent, 'recall_search', { action: 'search', mode: 'literal', patterns: ['needle'] }, human('Find needle using a new query.'));
    metrics.hotNewQuery = { elapsedMs: hot.elapsedMs, status: hot.status, code: hot.code, matchMs: hot.matchMs, matchedRecords: hot.matchedRecords };
    for (const row of [cold, hot]) if (row.status === 'ok') { assert.equal(row.value.scanComplete, true); assert.equal(row.value.scannedRecords, spec.records); assert.equal(row.value.totalHits, 1); }
    const item = hot.value?.items?.[0] ?? cold.value?.items?.[0];
    await phase('read');
    if (item) {
      const read = await invoke(agent, 'recall_read', { action: 'read', ref: item.ref });
      metrics.read = { elapsedMs: read.elapsedMs, status: read.status, tokens: read.estimatedOutputTokens };
      if (read.status === 'ok') assert.ok(read.value.items.some(i => i.content.includes('benchmark-hit needle')));
    }
    for (let i = 0; i < 3; i++) {
      await phase(`retained-${i}`);
      const id = `retained-${i}`; await seed(ctx, id, bodies); const prepared = await prepare(id); global.gc?.();
      memoryGrowth.push({ addedSession: id, prepared, sessions: ctx.recallPreparation.snapshot().length,
        canonicalRecords: ctx.recallPreparation.snapshot().reduce((n, s) => n + s.records, 0), memory: process.memoryUsage() }); meter.sample();
    }
    const bytes = 4 * 1024 * 1024;
    await phase('attachment');
    const file = await ctx.attachments.saveFile({ data: Buffer.alloc(bytes, 97), name: 'benchmark-archive.txt' });
    await seed(ctx, 'benchmark-attachment', ['needle archive performance source'], file);
    const handle = await ctx.agents.resume({ resumeSessionId: 'benchmark-attachment', agentOptions: h.model.options }); h.agents.push(handle);
    const found = await invoke(handle.agent, 'recall_search', { action: 'search', mode: 'literal', patterns: ['needle'] }, human('Find archive.'));
    assert.equal(found.status, 'ok'); const source = found.value.items[0];
    const access = await invoke(handle.agent, 'recall_read', { action: 'read', ref: source.ref, target: 'attachments', attachments: source.attachments.map(a => a.ref) });
    metrics.attachment = { bytes, elapsedMs: access.elapsedMs, status: access.status, tokens: access.estimatedOutputTokens,
      version: access.value?.attachmentResults?.[0]?.version.state };
    if (access.status === 'ok') { assert.equal(access.value.attachmentResults[0].state, 'accessible'); assert.equal(access.value.attachmentResults[0].version.state, 'same'); }
    metrics.rg = matcher.info;
    metrics.toolCalls = tools.length; metrics.toolTimeouts = tools.filter(t => timeoutCode(t.code)).length;
    metrics.toolTimeoutFraction = metrics.toolCalls ? metrics.toolTimeouts / metrics.toolCalls : null;
    metrics.failedTools = tools.filter(t => t.status !== 'ok').length;
    metrics.totalEstimatedOutputTokens = tools.reduce((n, t) => n + t.estimatedOutputTokens, 0);
    global.gc?.(); meter.sample();
    meter.stop(); capture?.stop();
    await phase('complete');
    return snapshot();
  } finally { restore(); closePage(); await h.dispose(); meter?.stop(); capture?.stop(); }
}
