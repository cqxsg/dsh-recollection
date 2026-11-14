import assert from 'node:assert/strict';
import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import { classifyHistoryRange, loadRecallConfig, startPerformanceCapture } from '../lib/index.js';
import { createHistoryFixture } from '../support/fixtures/history.mjs';
import { rangeFixture, text } from '../support/fixtures/range.mjs';
import { recallHarness } from '../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../support/fixtures/scripted-model.mjs';
import { makeCorpus, QUERIES, BOUNDARY_QUERIES, LEGACY_QUERIES, expectedIndexes, queryArgs } from './corpus.mjs';
import { digest, resourceMeter } from '../support/measurement.mjs';
import { semanticPerformanceResult } from './report.mjs';

export async function seedMatrixHistory(ctx, id, rows) {
  const fixture = await createHistoryFixture(ctx, id, []), f = rangeFixture(fixture.session);
  try {
    f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
    f.append('system/message', { turn: 1, step: 1, message: { id: `${id}-system`, role: 'system', source: { kind: 'system-prompt' }, content: [text('fixture system')] } }, { surfaceOp: 'append' });
    for (const row of rows) {
      f.append('user/message', { id: `${id}-row-${row.index}`, role: 'user', source: { kind: 'user' },
        content: [...row.parts.map(text), ...(row.attachment ? [{ type: 'file', attachment: row.attachment }] : [])] }, { surfaceOp: 'append' });
      if (row.index % 64 === 63) await new Promise(resolve => setImmediate(resolve));
    }
    f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.summary([...fixture.session.surface.nodes].filter(seq => fixture.session.snapshotEvents()[seq].type !== 'system/message'));
    await fixture.flush();
    return { events: fixture.session.seq, storedBytes: (await ctx.sessionPersistence.stat(id)).sizeBytes };
  } finally { await fixture.close(); }
}

export async function matrixTrial(ctx, spec, progress) {
  const config = loadRecallConfig(), corpus = makeCorpus(spec.profile, spec.records), { records, ...manifest } = corpus;
  const h = recallHarness(ctx), metrics = {}, tools = [], stages = [], skipped = [];
  const id = 'matrix-history'; let meter, capture, stored, originalMatch, matcher, closePage = () => {};
  const snapshot = () => ({ mode: 'performance', suite: 'matrix', profile: spec.profile, benchmark: spec.benchmark,
    querySet: spec.queries, records: spec.records, sourceDigest: corpus.sourceDigest, manifest, config, stored, metrics, tools, stages, skipped,
    diagnosticsEnabled: !!spec.diagnostics, diagnostics: capture?.snapshot(), resources: meter?.snapshot(),
    semanticDigest: digest({ tools: semanticPerformanceResult(tools), skipped: skipped.map(r => r.query), preparation: metrics.preparation?.status }),
    coldDefinition: 'plugin cold; OS file cache not flushed', gcAtMemoryBoundaries: typeof global.gc === 'function' });
  const phase = async name => { stages.push({ name, startedMs: performance.now() }); await progress(name, snapshot); };
  try {
    await phase('fixture'); stored = await seedMatrixHistory(ctx, id, records);
    global.gc?.(); meter = resourceMeter(); capture = spec.diagnostics ? startPerformanceCapture({ maxEvents: spec.diagnosticMaxEvents }) : undefined;
    if (spec.benchmark === 'prepare') {
      await phase('native-acquisition');
      const began = performance.now();
      await ctx.recallHistory.withSnapshot(id, snapshot => {
        metrics.nativeAcquisitionMs = performance.now() - began;
        let start = performance.now(); foldSurface(snapshot.events, ctx.sessions.messageProjections); metrics.foldMs = performance.now() - start;
        start = performance.now(); classifyHistoryRange(snapshot, ctx.sessions.messageProjections); metrics.classifyMs = performance.now() - start;
      });
      const current = 'matrix-small'; await seedMatrixHistory(ctx, current, [{ index: 0, parts: ['small current history'] }]);
      const pageId = 'matrix-page', signal = new AbortController().signal;
      const registration = ctx.recallHost.openPage({ protocolVersion: 1, pageId, registrationSequence: 1, sessionId: current }, signal);
      let sequence = 0;
      const report = closed => ctx.recallHost.reportView({ protocolVersion: 1, pageId, ...registration, sequence: ++sequence, activationSequence: 1,
        view: { sessionId: current, selection: 'selected', conversationVisible: !closed, visible: !closed, focused: !closed, closed } }, signal);
      closePage = () => report(true);
      await phase('independent-preparation');
      const due = performance.now() + 5;
      const notification = new Promise((resolve, reject) => setTimeout(async () => {
        try {
          const at = performance.now(), largeState = ctx.recallPreparation.status(id)?.state;
          const receipt = report(false), receiptAt = performance.now(); assert.ok(receipt.accepted);
          const handle = await ctx.recallPreparation.wait(current, AbortSignal.timeout(config.prepareMs));
          assert.equal(ctx.recallPreparation.records(handle).length, 1);
          resolve({ timerDelayMs: Math.max(0, at - due), hostReceiptMs: receiptAt - at, activationToReadyMs: performance.now() - receiptAt,
            duringPreparation: ['queued', 'preparing'].includes(largeState), largeState });
        } catch (error) { reject(error); }
      }, 5));
      const start = performance.now();
      const preparation = (async () => {
        try {
          const handle = await ctx.recallPreparation.wait(id, AbortSignal.timeout(config.prepareMs));
          const total = ctx.recallPreparation.records(handle).length; assert.equal(total, spec.records);
          return { status: 'ok', elapsedMs: performance.now() - start, records: total };
        } catch (error) {
          if (error.name !== 'TimeoutError') throw error;
          return { status: 'incomplete', code: 'preparation_timeout', elapsedMs: performance.now() - start };
        }
      })();
      [metrics.preparation, metrics.notification] = await Promise.all([preparation, notification]);
      metrics.preparationState = ctx.recallPreparation.status(id);
    } else {
      await phase('resume');
      const started = performance.now(), handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle);
      metrics.nativeResumeMs = performance.now() - started;
      matcher = ctx.recallTools.search.matcher; originalMatch = matcher.match;
      let matches = 0, matchMs = 0;
      matcher.match = async (...args) => { const at = performance.now(); try { return await originalMatch.apply(matcher, args); } finally { matches++; matchMs += performance.now() - at; } };
      const invoke = async (query, label) => {
        await phase(`${label}:${query.id}`);
        const before = matches, beforeMs = matchMs, at = performance.now();
        const [native] = await h.drive(handle.agent, [{ name: 'recall_search', args: queryArgs(query) }], human(`Run fixed query ${query.id}.`));
        const value = native.value, expected = expectedIndexes(query, spec.records);
        const row = { name: 'recall_search', phase: label, query: query.id, startedMs: at, elapsedMs: performance.now() - at,
          status: value?.status ?? 'native_error', code: value?.code ?? native.data.error?.code, matchedRecords: matches - before, matchMs: matchMs - beforeMs,
          expectedHits: expected.length, outputTokens: estimateContent(native.data.message.content), value };
        tools.push(row);
        if (value?.status === 'ok') {
          assert.ok(row.outputTokens <= 2000); assert.equal(value.scanComplete, true);
          assert.equal(value.scannedRecords, spec.records); assert.equal(value.totalHits, expected.length);
          assert.equal(row.matchedRecords, label === 'reuse' ? 0 : spec.records);
          for (const item of value.items) assert.ok(expected.includes(Number(item.source.messageId.split('-row-').at(-1))));
        } else assert.ok(!value?.scanComplete && !value?.items?.length, 'Incomplete work cannot publish hits');
        return row;
      };
      const cold = spec.profile === 'legacy' ? LEGACY_QUERIES[0] : { id: 'cold', mode: 'literal', patterns: ['ColdSeedToken'], case_sensitive: true, rate: 'cold' };
      metrics.coldCacheEmpty = ctx.recallPreparation.status(id) === undefined;
      assert.ok(metrics.coldCacheEmpty);
      const first = await invoke(cold, 'cold');
      metrics.cold = { elapsedMs: first.elapsedMs, status: first.status, code: first.code };
      metrics.preparedBeforeHot = ctx.recallPreparation.status(id)?.state === 'ready';
      const queries = spec.profile === 'legacy' ? [LEGACY_QUERIES[1]] : spec.queries === 'all' ? [...QUERIES, ...BOUNDARY_QUERIES]
        : [...QUERIES, ...BOUNDARY_QUERIES].filter(q => spec.queries === 'primary' ? q.primary : spec.queries.split(',').includes(q.id));
      let successful;
      for (const query of queries) {
        if (!metrics.preparedBeforeHot) skipped.push({ query: query.id, status: 'not_run_preparation_incomplete' });
        else { const row = await invoke(query, 'hot'); if (row.status === 'ok') successful ??= query; }
      }
      if (successful) await invoke(successful, 'reuse');
      const found = tools.find(t => t.status === 'ok' && t.value.items?.length)?.value.items[0];
      if (found) {
        await phase('body-read'); const at = performance.now();
        const [read] = await h.drive(handle.agent, [{ name: 'recall_read', args: { action: 'read', ref: found.ref } }], recovery());
        metrics.bodyRead = { elapsedMs: performance.now() - at, status: read.value?.status, outputTokens: estimateContent(read.data.message.content) };
        if (read.value?.status === 'ok') assert.ok(metrics.bodyRead.outputTokens <= 4000);
      }
      metrics.rg = matcher.info;
    }
    meter.stop(); capture?.stop(); await phase('complete'); return snapshot();
  } finally {
    if (originalMatch) matcher.match = originalMatch;
    closePage(); await h.dispose(); meter?.stop(); capture?.stop();
  }
}
