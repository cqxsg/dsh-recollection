import assert from 'node:assert/strict';
import { CallTimeline, loadRecallConfig, startPerformanceCapture } from '../../lib/index.js';
import { deferred, replace } from '../../support/fixtures/control.mjs';
import { human } from '../../support/fixtures/scripted-model.mjs';

export async function verifyMatchingScheduling(ctx, h, check) {
  await check('four native search calls share two workers and newer activation takes the next complete unit with original accounting', async () => {
    const matcher = ctx.recallTools.search.matcher, timelines = [0, 1].map(() => new CallTimeline(loadRecallConfig(), new AbortController().signal));
    try { await Promise.all(timelines.map(t => matcher.validate({ patterns: ['warm'], mode: 'literal', case_sensitive: true }, t))); }
    finally { timelines.forEach(t => t.dispose()); }
    const fixtures = [];
    for (let i = 0; i < 4; i++) { const f = await h.seed(`recall-matching-${i}`, Array.from({ length: 20 }, (_, j) => `needle ${i} record ${j}`)); fixtures.push(f); await ctx.recallPreparation.wait(f.agent.id); }
    const release = deferred(), starts = [], restores = [], capture = startPerformanceCapture(); let peak = 0, active = 0, calls;
    const signal = new AbortController().signal, pageId = 'matching-priority-page';
    let registration;
    for (const channel of matcher.pool.channels) {
      const run = channel.request.bind(channel);
      restores.push(replace(channel, 'request', async (text, terms, timeline, unit, ...rest) => {
        const ticket = timeline.operation;
        assert.ok(ticket, 'production tool owns a trusted operation ticket');
        const at = starts.length; starts.push({ sessionId: ticket.sessionId, order: ticket.order, priority: ticket.priority(), purpose: unit.purpose });
        active++; peak = Math.max(peak, active);
        try { if (at < 2) await release.promise; return await run(text, terms, timeline, unit, ...rest); }
        finally { active--; }
      }));
    }
    try {
      calls = fixtures.map(f => h.search(f.agent, human('four concurrent searches')));
      const end = performance.now() + 5000;
      while (matcher.stats().queued < 2 && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(starts.length, 2); assert.ok(matcher.stats().queued >= 2); assert.equal(matcher.stats().live, 2);
      const current = fixtures.findLast(f => !starts.some(s => s.sessionId === f.agent.id)); assert.ok(current);
      registration = ctx.recallHost.openPage({ protocolVersion: 1, pageId, registrationSequence: 1, sessionId: current.agent.id }, signal);
      const view = { sessionId: current.agent.id, selection: 'selected', conversationVisible: true, visible: true, focused: true, closed: false };
      ctx.recallHost.reportView({ protocolVersion: 1, pageId, ...registration, sequence: 1, activationSequence: 1, view }, signal);
      release.resolve(); const results = await Promise.all(calls);
      assert.equal(starts[2].sessionId, current.agent.id); assert.equal(starts[2].priority, 0); assert.equal(peak, 2);
      for (const result of results) {
        assert.equal(result.value.status, 'ok'); assert.equal(result.value.scanComplete, true); assert.equal(result.value.totalHits, 20);
        assert.equal(result.value.budget.search_remaining, 5); assert.equal(result.value.budget.shared_remaining, 11);
      }
      for (const f of fixtures) assert.equal(new Set(starts.filter(s => s.sessionId === f.agent.id).map(s => s.order)).size, 1, 'order persists across records');
      assert.equal(matcher.stats().active, 0); assert.equal(matcher.stats().queued, 0); assert.equal(matcher.stats().live, 2);
      ctx.recallHost.reportView({ protocolVersion: 1, pageId, ...registration, sequence: 2, activationSequence: 1, view: { ...view, closed: true } }, signal);
      console.log(JSON.stringify({ matchingConcurrency: peak, starts: starts.slice(0, 12), units: starts.length, diagnostics: capture.snapshot().aggregates }));
    } finally { release.resolve(); await Promise.allSettled(calls ?? []); restores.forEach(restore => restore()); capture.stop(); }
  });
}
