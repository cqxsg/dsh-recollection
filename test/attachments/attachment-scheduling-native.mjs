import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RecallHashLedger, RecallAttachmentService, loadRecallConfig } from '../../lib/index.js';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, text } from '../../support/fixtures/range.mjs';

const until = async predicate => { const deadline = performance.now() + 20000; while (!predicate()) { assert.ok(performance.now() < deadline, 'condition timed out'); await new Promise(r => setTimeout(r, 5)); } };
export async function verifyAttachmentScheduling(ctx) {
  const cases = [], fixtures = [], jobs = [], signal = new AbortController().signal;
  const check = async (name, fn) => { await fn(); cases.push(name); console.log(`PASS: ${name}`); };
  const fixture = async (id, body = 'original') => { const f = await createHistoryFixture(ctx, id, [body]); fixtures.push(f); rangeFixture(f.session).summary([...f.session.surface.nodes]); await f.flush(); return f; };
  const old = await fixture('hash-old', '@old.txt'); await writeFile('old.txt', 'old content');
  const hashes = await ctx.plugin(RecallHashLedger, loadRecallConfig()); let admission = await ctx.plugin(RecallAttachmentService);
  const report = (() => {
    const pageId = 'combined-page', registration = ctx.recallHost.openPage({ protocolVersion: 1, pageId, registrationSequence: 1, sessionId: old.session.id }, signal);
    let sequence = 0, activation = 0;
    return (id, patch = {}) => ctx.recallHost.reportView({ protocolVersion: 1, pageId, ...registration, sequence: ++sequence, activationSequence: ++activation,
      view: { sessionId: id, selection: 'selected', conversationVisible: true, visible: true, focused: true, closed: false, ...patch } }, signal);
  })();
  try {
    await check('opening old history never invents a baseline; only new native references are admitted and duplicates stay idempotent', async () => {
      await ctx.recallPreparation.wait(old.session.id); assert.equal(ctx.recallHashes.records().length, 0);
      const f = await fixture('hash-admission'); await writeFile('new.txt', 'first version');
      const event = rangeFixture(f.session).user([text('@new.txt @new.txt')]); await f.flush(); await ctx.recallAttachments.idleAdmissions();
      await until(() => ctx.recallHashes.records().filter(r => r.source.sessionId === f.session.id && r.state === 'saved').length === 2);
      const first = ctx.recallHashes.records().filter(r => r.source.sessionId === f.session.id);
      assert.notEqual(first[0].source.selector, first[1].source.selector);
      assert.ok(first.every(r => r.sample.hash === createHash('sha256').update('first version').digest('hex')));
      await ctx.recallHashes.register(first[0].source); await ctx.recallPreparation.wait(f.session.id); assert.equal(ctx.recallHashes.records().length, 2);
      await writeFile('new.txt', 'second version'); rangeFixture(f.session).user([text('@new.txt')]); await f.flush(); await ctx.recallAttachments.idleAdmissions();
      await until(() => ctx.recallHashes.records().filter(r => r.state === 'saved').length === 3);
      assert.ok(ctx.recallHashes.records().some(r => r.sample.hash !== first[0].sample.hash));
    });
    await check('plugin reattachment, inherited seeds and excluded replacement messages cannot retroactively register references', async () => {
      await admission.dispose(); rangeFixture(old.session).user([text('@old.txt')]); await old.flush();
      admission = await ctx.plugin(RecallAttachmentService);
      await ctx.recallPreparation.wait(old.session.id);
      const fork = await createHistoryFixture(ctx, 'hash-seeded-child', [], old.session); fixtures.push(fork);
      await ctx.recallPreparation.wait(fork.session.id);
      rangeFixture(old.session).user([text('@old.txt')], { kind: 'compact-checkpoint', compactionId: 'injected-summary' }); await old.flush();
      await ctx.recallAttachments.idleAdmissions(); assert.equal(ctx.recallHashes.records().length, 3);
    });
    await check('real preparation queue executes all five priorities, keeps session FIFO, and pauses lower work during a foreground call', async () => {
      const a = await fixture('combined-a'), b = await fixture('combined-b'), c = await fixture('combined-c');
      const trace = [], gate = Promise.withResolvers(), entered = Promise.withResolvers(); let batches = 0;
      // Prime one shared batch, then introduce all higher-priority demand.
      jobs.push(ctx.recallPreparation.scheduleHash('a-one', a.session.id, async () => { trace.push('hash-a'); if (++batches === 1) { entered.resolve(); await gate.promise; } return batches === 3; }, e => { throw e; }));
      await entered.promise;
      jobs.push(ctx.recallPreparation.scheduleHash('b-one', b.session.id, async () => { trace.push('hash-b'); return true; }, e => { throw e; }));
      jobs.push(ctx.recallPreparation.scheduleHash('a-two', a.session.id, async () => { trace.push('hash-a-two'); return true; }, e => { throw e; }));
      const raw = ctx.recallHistory.withSnapshot;
      ctx.recallHistory.withSnapshot = async function(id, ...args) { if (id.startsWith('combined-')) trace.push(`history-${id.at(-1)}`); return raw.call(this, id, ...args); };
      try {
        report(a.session.id);
        const pendingB = ctx.recallPreparation.wait(b.session.id); ctx.recallPreparation.warm(c.session.id);
        const release = ctx.recallPreparation.holdOperation(a.session.id);
        gate.resolve(); await until(() => ctx.recallPreparation.status(a.session.id)?.state === 'ready');
        const checkpoint = trace.length; await new Promise(r => setTimeout(r, 30)); assert.equal(trace.length, checkpoint, 'current business has priority over background sampling');
        report(a.session.id, { focused: false }); release();
        await pendingB; await until(() => ctx.recallPreparation.status(c.session.id)?.state === 'ready');
        assert.deepEqual(trace, ['hash-a', 'history-a', 'hash-a', 'hash-a', 'hash-a-two', 'history-b', 'hash-b', 'history-c']);
      } finally { gate.resolve(); ctx.recallHistory.withSnapshot = raw; report(a.session.id, { closed: true }); }
    });
    await check('a registered task with unverifiable native provenance fails before any file read', async () => {
      await admission.dispose();
      const key = await ctx.recallHashes.register({ sessionId: old.session.id, seq: 9999, messageId: 'missing-source', block: 0, selector: 'p0:0', fingerprint: 'absent', referenceText: '@old.txt', path: join(process.cwd(), 'old.txt'), recordedAt: 1 });
      const original = ctx.fs.readByteRange; let reads = 0; ctx.fs.readByteRange = async function(...args) { reads++; return original.apply(this, args); };
      try {
        admission = await ctx.plugin(RecallAttachmentService);
        await until(() => ctx.recallHashes.get(key).state === 'failed');
        assert.equal(ctx.recallHashes.get(key).reason, 'source_unverifiable'); assert.equal(reads, 0);
      } finally { ctx.fs.readByteRange = original; }
    });
    await check('unloading admission cancels and drains real hash I/O; reattachment resumes the registered task without resetting attempts', async () => {
      const f = await fixture('hash-unload'), path = join(process.cwd(), 'unload.bin'); await writeFile(path, Buffer.alloc(600000, 7));
      const original = ctx.fs.readByteRange, entered = Promise.withResolvers(); let blocked = true, active = 0;
      ctx.fs.readByteRange = async function(target, range, scope) {
        if (this.processPath(target) === path && blocked) {
          active++; entered.resolve();
          try { await new Promise((resolve, reject) => { const abort = () => reject(scope.reason); scope.addEventListener('abort', abort, { once: true }); if (scope.aborted) abort(); }); }
          finally { active--; }
        }
        return original.call(this, target, range, scope);
      };
      try {
        rangeFixture(f.session).user([text('@unload.bin')]); await f.flush(); await entered.promise;
        await admission.dispose(); assert.equal(active, 0);
        const paused = ctx.recallHashes.records().find(r => r.source.sessionId === f.session.id);
        assert.equal(paused.attempts, 1); assert.equal(paused.reserved, undefined); assert.equal(paused.state, 'pending');
        blocked = false; admission = await ctx.plugin(RecallAttachmentService);
        await until(() => ctx.recallHashes.records().find(r => r.source.sessionId === f.session.id)?.state === 'saved');
        assert.equal(ctx.recallHashes.records().find(r => r.source.sessionId === f.session.id).attempts, 2);
      } finally { blocked = false; ctx.fs.readByteRange = original; }
    });
    const evidence = join(process.env.DSH_HOME, '..', 'attachment-scheduling-evidence.json');
    await writeFile(evidence, JSON.stringify({ cases, records: ctx.recallHashes.records(), status: ctx.recallAttachments.status() }, null, 2)); console.log(`Attachment scheduling evidence: ${evidence}`);
  } finally { jobs.forEach(cancel => cancel()); await admission.dispose(); await hashes.dispose(); for (const f of fixtures) await f.close(false); }
}
