import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice';
import { currentInteraction, renderedTokens, RecallReadEngine, RecallAttachmentService, loadRecallConfig } from '../../lib/index.js';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, text } from '../../support/fixtures/range.mjs';
import { fixturePng } from '../fixtures/image.mjs';

const until = async predicate => { const end = performance.now() + 15000; while (!predicate()) { assert.ok(performance.now() < end, 'task timed out'); await new Promise(r => setTimeout(r, 5)); } };
export async function verifyAttachmentRead(ctx) {
  const h = recallHarness(ctx), cases = [], samples = [];
  const check = async (name, fn) => { await fn(); cases.push(name); console.log(`PASS: ${name}`); };
  const file = await ctx.attachments.saveFile({ data: Buffer.from('archived document bytes'), name: 'source.docx' });
  const image = await ctx.attachments.saveImage({ data: fixturePng(), mediaType: 'image/png' });
  const seed = async (id, content, sample = false, spill) => {
    if (!sample) { await ctx.recallAttachments.idleAdmissions(); await [...ctx.registry.get(RecallAttachmentService).fibers].find(f => f.state === 2).dispose(); }
    const f = await createHistoryFixture(ctx, id, []);
    const r = rangeFixture(f.session);
    r.append('turn/start', { turn: 1 }); r.append('step/start', { turn: 1, step: 1 });
    r.append('system/message', { turn: 1, step: 1, message: { id: `${id}-sys`, role: 'system', source: { kind: 'system-prompt' }, content: [text('fixture system')] } }, { surfaceOp: 'append' });
    r.user(content);
    if (spill) { const call = r.callBlock(`${id}-call`, 'example', '{}'); r.assistant([call], 1, 1); const log = r.callLog(call, 1, 1); r.result(call, log, [text(`needle saved preview\n\n${formatSpillNotice({ kind: 'exact', count: 200 }, spill)}`)], 1, 1); }
    r.append('step/end', { turn: 1, step: 1 }); r.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const groups = [[]];
    for (const seq of f.session.surface.nodes) { if (f.session.snapshotEvents()[seq].type === 'system/message') groups.push([]); else groups.at(-1).push(seq); }
    for (const group of groups) if (group.length) r.summary(group);
    await f.flush(); if (sample) await ctx.recallAttachments.idleAdmissions();
    if (sample && content.some(b => b.type === 'text' && b.text.includes('@'))) await until(() => ctx.recallHashes.records().filter(row => row.source.sessionId === id).every(row => ['saved', 'failed'].includes(row.state)) && ctx.recallHashes.records().some(row => row.source.sessionId === id));
    await f.close(); if (!sample) await ctx.plugin(RecallAttachmentService);
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle); return handle.agent;
  };
  const drive = async (agent, args, input = recovery()) => {
    const [native] = await h.drive(agent, [{ name: 'recall_read', args }], input); samples.push(native.value ?? native.data.error); return native;
  };
  const request = (item, target = 'attachments', attachments = item.attachments.map(a => a.ref)) => ({ action: 'read', ref: item.ref, target, attachments });
  const findAll = async agent => { let page = (await h.search(agent)).value; assert.equal(page.status, 'ok'); const items = [...page.items]; while (page.nextCursor) { page = (await h.next(agent, page.nextCursor)).value; assert.equal(page.status, 'ok'); items.push(...page.items); } return items; };
  try {
    await check('search and text access no files; explicit native files/images/spill reuse original paths and one R for both', async () => {
      const spill = await ctx.spillStore.saveText({ owner: { sessionId: 'attachment-product' }, source: { kind: 'tool', toolName: 'example', callId: 'spill', label: 'result' }, suggestedName: 'result.txt', content: 'full saved output' });
      const agent = await seed('attachment-product', [text('needle history'), { type: 'file', attachment: file }, { type: 'image', attachment: image }], false, spill);
      const original = ctx.fs.readByteRange; let reads = [];
      ctx.fs.readByteRange = async function(target, ...args) { reads.push(this.processPath(target)); return original.call(this, target, ...args); };
      try {
        const found = await findAll(agent);
        const media = found.find(i => i.attachments.some(a => a.type === 'file'));
        await h.read(agent, media.ref); assert.equal(reads.length, 0);
        const before = ctx.recallBudget.state(currentInteraction(agent.session)).shared;
        const result = (await drive(agent, request(media, 'both', [media.attachments.find(a => a.type === 'file').ref]))).value;
        assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.budget.shared_remaining, before - 1); assert.equal(result.items[0].content, 'needle history');
        assert.equal(result.attachmentResults[0].path, ctx.attachments.fileHostPath(file)); assert.equal(result.attachmentResults[0].version.state, 'same');
        assert.equal(result.attachmentResults[0].contentRead, false); assert.ok(reads.length > 0); assert.ok(reads.every(path => path === ctx.attachments.fileHostPath(file)));
        const picture = (await drive(agent, request(media, 'attachments', [media.attachments.find(a => a.type === 'image').ref]))).value;
        assert.equal(picture.attachmentResults[0].storage, 'normalized_image'); assert.equal(picture.attachmentResults[0].path, ctx.attachments.imageHostPath(image));
        const spillItem = found.find(i => i.attachments.some(a => a.type === 'spill'));
        const saved = (await drive(agent, request(spillItem))).value; assert.equal(saved.attachmentResults[0].path, spill.locator); assert.equal(saved.attachmentResults[0].version.state, 'unverified');
        assert.equal(saved.readComplete, true); assert.equal(saved.textRequested, false); assert.equal(saved.items.length, 0);
      } finally { ctx.fs.readByteRange = original; }
    });
    await check('live reference baselines compare same/different; hash failure leaves a usable unverified path and never overwrites the baseline', async () => {
      const path = join(process.cwd(), 'versioned.txt'); await writeFile(path, 'historical version');
      const agent = await seed('attachment-versions', [text('needle @versioned.txt')], true);
      const baseline = ctx.recallHashes.records().find(r => r.source.sessionId === agent.id); assert.equal(baseline.state, 'saved');
      const item = (await h.search(agent)).value.items[0];
      const same = (await drive(agent, request(item))).value; assert.equal(same.attachmentResults[0].version.state, 'same'); assert.equal(same.attachmentResults[0].version.baselineAt, baseline.sample.completedAt);
      await writeFile(path, 'current changed version'); const changed = (await drive(agent, request(item))).value; assert.equal(changed.attachmentResults[0].version.state, 'different');
      const read = ctx.fs.readByteRange;
      ctx.fs.readByteRange = async function(target, range, signal) { if (range.length > 1) throw Object.assign(new Error('transient'), { code: 'FS_IO_ERROR' }); return read.call(this, target, range, signal); };
      try { const unknown = (await drive(agent, request(item))).value.attachmentResults[0]; assert.equal(unknown.state, 'accessible'); assert.equal(unknown.path, path); assert.equal(unknown.version.state, 'unverified'); }
      finally { ctx.fs.readByteRange = read; }
      assert.deepEqual(ctx.recallHashes.records().find(r => r.source.sessionId === agent.id), baseline);
      await unlink(path); const missing = (await drive(agent, request(item, 'both'))).value;
      assert.equal(missing.attachmentResults[0].state, 'missing'); assert.equal(missing.attachmentResults[0].path, undefined); assert.equal(missing.sourceComplete, false); assert.match(missing.items[0].content, /needle/);
    });
    await check('old unsampled refs, access denial, no mapping and foreign attachment selections have explicit independent outcomes', async () => {
      await writeFile('old-only.txt', 'current file'); const agent = await seed('attachment-old', [text('needle @old-only.txt')]);
      const item = (await h.search(agent)).value.items[0]; assert.equal(ctx.recallHashes.records().some(r => r.source.sessionId === agent.id), false);
      const unknown = (await drive(agent, request(item))).value; assert.equal(unknown.attachmentResults[0].version.reason, 'baseline_never_registered');
      const stat = ctx.fs.stat; ctx.fs.stat = async function(target, ...args) { if (this.processPath(target) === join(process.cwd(), 'old-only.txt')) throw Object.assign(new Error('denied'), { code: 'FS_PERMISSION_DENIED' }); return stat.call(this, target, ...args); };
      try { const denied = (await drive(agent, request(item))).value; assert.equal(denied.attachmentResults[0].state, 'permission_denied'); assert.equal(denied.attachmentResults[0].path, undefined); }
      finally { ctx.fs.stat = stat; }
      const other = await seed('attachment-other', [text('needle'), { type: 'file', attachment: file }]); const foreign = (await h.search(other)).value.items.find(i => i.attachments.length);
      const invalid = (await drive(agent, request(item, 'attachments', [foreign.attachments[0].ref]))).value; assert.equal(invalid.code, 'invalid_attachment');
      const mapping = ctx.fs.processPathFromHostPath; ctx.fs.processPathFromHostPath = function(path) { return path === ctx.attachments.fileHostPath(file) ? undefined : mapping.call(this, path); };
      try { const unreachable = (await drive(other, request(foreign))).value; assert.equal(unreachable.attachmentResults[0].state, 'unreachable'); }
      finally { ctx.fs.processPathFromHostPath = mapping; }
      assert.equal(ctx.recallHashes.records().some(r => r.source.sessionId === agent.id), false);
    });
    await check('failed historical sampling stays unverified after the file appears; inherited relative paths do not use the child cwd', async () => {
      const agent = await seed('attachment-failed-baseline', [text('needle @not-yet-created.txt')], true);
      const baseline = ctx.recallHashes.records().find(r => r.source.sessionId === agent.id); assert.equal(baseline.state, 'failed');
      await writeFile('not-yet-created.txt', 'newly created');
      const item = (await h.search(agent)).value.items[0], result = (await drive(agent, request(item))).value;
      assert.equal(result.attachmentResults[0].state, 'accessible'); assert.equal(result.attachmentResults[0].version.state, 'unverified');
      assert.equal(result.attachmentResults[0].version.reason, baseline.reason);
      assert.deepEqual(ctx.recallHashes.records().find(r => r.source.sessionId === agent.id), baseline);
      const fixture = await createHistoryFixture(ctx, 'attachment-inherited', [], agent.session); await fixture.flush(); await fixture.close();
      const handle = await ctx.agents.resume({ resumeSessionId: 'attachment-inherited', agentOptions: h.model.options }); h.agents.push(handle);
      const inherited = (await h.search(handle.agent)).value.items.find(i => i.attachments.length);
      assert.equal(inherited.source.inherited, true);
      const unresolved = (await drive(handle.agent, request(inherited))).value;
      assert.equal(unresolved.attachmentResults[0].state, 'unresolved'); assert.equal(unresolved.attachmentResults[0].path, undefined);
      assert.equal(ctx.recallHashes.records().some(r => r.source.sessionId === handle.agent.id), false);
    });
    await check('both uses fixed independent file/text cursors and output limits; failed delivery retries the same position and reload expires cursors', async () => {
      const agent = await seed('attachment-pages', [text('needle ' + '中文😀 page '.repeat(600)), { type: 'file', attachment: file }, { type: 'file', attachment: file }, { type: 'image', attachment: image }], true);
      const item = (await h.search(agent)).value.items[0]; assert.ok(item);
      const old = ctx.recallTools.read; ctx.recallTools.read = new RecallReadEngine(ctx, loadRecallConfig());
      try {
        let page = (await drive(agent, request(item, 'both'))).value; assert.equal(page.status, 'ok'); assert.ok(page.nextCursor); assert.ok(renderedTokens(page) <= 2000);
        const cursor = page.nextCursor, fileRefs = [...page.attachmentResults.map(f => f.ref)], bodies = page.items.map(i => i.content);
        const block = ctx.on('tools/post-execute', async (exec, result, next) => { const decision = await next(); return exec.agent?.id === agent.id && exec.name === 'recall_read' ? { kind: 'block', feedback: [text('injected delivery failure')] } : decision; });
        try { const failed = await drive(agent, { action: 'next', cursor }); assert.equal(failed.data.message.isError, true); } finally { await block(); }
        page = (await drive(agent, { action: 'next', cursor })).value; assert.equal(page.status, 'ok');
        fileRefs.push(...page.attachmentResults.map(f => f.ref)); bodies.push(...page.items.map(i => i.content));
        while (page.nextCursor) { page = (await drive(agent, { action: 'next', cursor: page.nextCursor })).value; assert.equal(page.status, 'ok'); assert.ok(renderedTokens(page) <= 2000); fileRefs.push(...page.attachmentResults.map(f => f.ref)); bodies.push(...page.items.map(i => i.content)); }
        assert.equal(page.readComplete, true); assert.equal(page.attachmentsComplete, true); assert.deepEqual(fileRefs, item.attachments.map(a => a.ref));
        assert.equal(bodies.join(''), 'needle ' + '中文😀 page '.repeat(600));
        const duplicate = (await drive(agent, { action: 'next', cursor }, human('new interaction old delivered cursor'))).value;
        // Across a new interaction an old valid read cursor is allowed and charged R.
        assert.equal(duplicate.status, 'ok');
        ctx.recallTools.read.clear(); const expired = (await drive(agent, { action: 'next', cursor })).value; assert.equal(expired.code, 'stale_reference'); assert.match(expired.recovery, /ref=rr2_/);
        const recovered = (await drive(agent, request(item))).value; assert.equal(recovered.status, 'ok');
      } finally { ctx.recallTools.read.clear(); ctx.recallTools.read = old; }
    });
    await check('actual PTC returns selected paths and counts only recall calls; current hash cancellation retains the charge and original baseline', async () => {
      const path = join(process.cwd(), 'ptc-reference.txt'); await writeFile(path, 'original');
      const agent = await seed('attachment-ptc', [text('needle @ptc-reference.txt')], true); setSandboxMode(agent.session, 'read-only');
      const native = agent.ctx.tools.presentAs('ptc');
      try {
        const [result] = await h.drive(agent, [{ name: 'run_code', args: { code: 'const s = await tools.recall_search({action:"search",mode:"literal",patterns:["needle"]}); const r = await tools.recall_read({action:"read",target:"both",ref:s.items[0].ref,attachments:s.items[0].attachments.map(a=>a.ref)}); return {status:r.status,path:r.attachmentResults[0].path};', description: 'Read historical reference path' } }], human('PTC attachments'));
        assert.equal(result.data.message.isError, false); const row = ctx.recallBudget.state(currentInteraction(agent.session)); assert.equal(row.actualCalls, 2); assert.equal(row.shared, 10); assert.ok(row.calls.every(c => c.kind === 'ptc'));
      } finally { native(); }
      const item = (await h.search(agent, human('cancel attachment verification'))).value.items[0];
      const original = ctx.fs.readByteRange, entered = Promise.withResolvers(); let active = 0;
      ctx.fs.readByteRange = async function(target, range, signal) {
        if (this.processPath(target) === path && range.length > 1) { active++; entered.resolve(); try { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); }); } finally { active--; } }
        return original.call(this, target, range, signal);
      };
      try {
        const pending = h.drive(agent, [{ name: 'recall_read', args: request(item) }], recovery(), false); await entered.promise; agent.cancel({ kind: 'user' }); const [cancelled] = await pending;
        assert.equal(cancelled.data.message.isError, true); assert.equal(cancelled.data.error.code, 'ABORTED'); assert.equal(active, 0); assert.equal(ctx.recallBudget.state(currentInteraction(agent.session)).shared, 10);
        assert.equal(ctx.recallHashes.records().find(r => r.source.sessionId === agent.id).state, 'saved');
      } finally { ctx.fs.readByteRange = original; }
    });
  } finally { await h.dispose(); }
  const evidence = join(process.env.DSH_HOME, '..', 'attachment-read-evidence.json'); await writeFile(evidence, JSON.stringify({ cases, samples }, null, 2)); console.log(`Attachment read evidence: ${evidence}`);
}
