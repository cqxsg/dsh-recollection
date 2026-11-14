import assert from 'node:assert/strict';
import { readFile, writeFile, stat, utimes, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice';
import { currentInteraction } from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { recovery } from '../../../support/fixtures/scripted-model.mjs';
import { createHistoryFixture } from '../../../support/fixtures/history.mjs';
import { rangeFixture, text } from '../../../support/fixtures/range.mjs';
import { fixturePng } from '../../fixtures/image.mjs';

const timer = setTimeout(() => process.exit(1), 110000);
const until = async predicate => { const end = performance.now() + 20000; while (!predicate()) { assert.ok(performance.now() < end, 'native background task timed out'); await new Promise(r => setTimeout(r, 5)); } };
const id = 'attachment-lifecycle', pendingId = 'attachment-live-pending';
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('attachment-lifecycle', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, mode = process.argv[3], h = recallHarness(ctx), root = join(process.env.DSH_HOME, '..');
  await h.ready();
  const seed = async (sessionId, content, spill) => {
    const fixture = await createHistoryFixture(ctx, sessionId, []), f = rangeFixture(fixture.session);
    f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
    f.append('system/message', { turn: 1, step: 1, message: { id: `${sessionId}-system`, role: 'system', source: { kind: 'system-prompt' }, content: [text('fixture system')] } }, { surfaceOp: 'append' });
    f.user(content);
    if (spill) { const call = f.callBlock('old-spill-call', 'example', '{}'); f.assistant([call], 1, 1); const log = f.callLog(call, 1, 1); f.result(call, log, [text('needle old preview\n\n' + formatSpillNotice({ kind: 'exact', count: 100 }, spill))], 1, 1); }
    f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.summary([...fixture.session.surface.nodes].filter(seq => fixture.session.snapshotEvents()[seq].type !== 'system/message'));
    await fixture.flush(); await fixture.close();
  };
  const resume = async () => { const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle); return handle.agent; };
  const select = (item, target = 'attachments') => ({ action: 'read', ref: item.ref, target, attachments: item.attachments.map(a => a.ref) });
  const call = async (agent, args) => { const [result] = await h.drive(agent, [{ name: 'recall_read', args }], recovery()); assert.equal(result.data.message.isError, false, JSON.stringify(result.data)); return result.value; };
  if (mode === 'prepare') {
    await writeFile('versioned.txt', 'persistent historical content'); await writeFile('pending.txt', 'pending historical content');
    const file = await ctx.attachments.saveFile({ data: Buffer.from('archived original document'), name: 'uploaded.docx' });
    const image = await ctx.attachments.saveImage({ data: fixturePng(), mediaType: 'image/png' });
    const spill = await ctx.spillStore.saveText({ owner: { sessionId: id }, source: { kind: 'tool', toolName: 'example', callId: 'old-spill-call', label: 'result' }, suggestedName: 'original.txt', content: 'persistent full original spill' });
    const aged = new Date(Date.now() - 90 * 86400000); await utimes(spill.locator, aged, aged);
    await seed(id, [text('needle @versioned.txt\n' + 'original 中文😀\n'.repeat(1600)), { type: 'file', attachment: file }, { type: 'image', attachment: image }], spill);
    await ctx.recallAttachments.idleAdmissions(); await until(() => ctx.recallHashes.records().find(r => r.source.sessionId === id)?.state === 'saved');
    const baseline = ctx.recallHashes.records().find(r => r.source.sessionId === id), agent = await resume();
    let page = (await h.search(agent)).value; const items = [...page.items]; while (page.nextCursor) { page = (await h.next(agent, page.nextCursor)).value; items.push(...page.items); }
    const media = items.find(i => i.attachments.some(a => a.type === 'file')), spillItem = items.find(i => i.attachments.some(a => a.type === 'spill'));
    assert.ok(media); assert.ok(spillItem);
    const first = await call(agent, select(media, 'both')); assert.equal(first.status, 'ok'); assert.ok(first.nextCursor);
    const saved = { pid: process.pid, media, spillItem, spill, filePath: ctx.attachments.fileHostPath(file), imagePath: ctx.attachments.imageHostPath(image), baseline,
      cursor: first.nextCursor, budget: ctx.recallBudget.state(currentInteraction(agent.session)), interactionId: currentInteraction(agent.session).interactionId };
    await writeFile(join(root, 'sources.json'), JSON.stringify(saved, null, 2));
    const read = ctx.fs.readByteRange;
    ctx.fs.readByteRange = async function(target, range, signal) {
      if (this.processPath(target) === join(process.cwd(), 'pending.txt') && range.length > 1) {
        const pending = ctx.recallHashes.records().find(r => r.source.sessionId === pendingId);
        process.send({ kind: 'reserved-live-hash', pid: process.pid, pending }); await new Promise(() => {});
      }
      return read.call(this, target, range, signal);
    };
    await seed(pendingId, [text('needle @pending.txt')]);
    await new Promise(() => {}); // Parent force-kills the real Host during its durable reservation.
  } else {
    const saved = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8')), checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
    assert.notEqual(saved.pid, process.pid); assert.equal(ctx.spillStore.config.cleanupPeriodDays, 0); assert.equal(ctx.spillStore.cleanup, undefined);
    assert.ok((await stat(saved.spill.locator)).mtimeMs < Date.now() - 80 * 86400000);
    assert.equal(await readFile(saved.spill.locator, 'utf8'), 'persistent full original spill');
    assert.deepEqual(ctx.recallHashes.records().find(r => r.source.sessionId === id), saved.baseline);
    await until(() => ctx.recallHashes.records().find(r => r.source.sessionId === pendingId)?.state === 'saved');
    const pending = ctx.recallHashes.records().find(r => r.source.sessionId === pendingId);
    assert.equal(pending.attempts, 2); assert.deepEqual(pending.limits, { attempts: 2, activeMs: 15000 });
    assert.ok(pending.spentMs >= checkpoint.pending.reserved.ms); assert.equal(pending.reserved, undefined);
    if (mode === 'relocate') { const prior = JSON.parse(await readFile(join(root, 'recover-evidence.json'), 'utf8')); assert.deepEqual(pending, prior.pending); }
    assert.equal(ctx.recallHashes.records().length, 2);
    const agent = await resume(), before = ctx.recallBudget.state(currentInteraction(agent.session));
    assert.equal(currentInteraction(agent.session).interactionId, saved.interactionId); assert.equal(before.limits.shared, 12);
    // Repeating the same delivered stale-cursor error would correctly close this
    // continuing interaction. Verify expiry once; later restarts use its anchor.
    let expired;
    if (mode === 'recover') {
      expired = await call(agent, { action: 'next', cursor: saved.cursor }); assert.equal(expired.code, 'stale_reference'); assert.ok(expired.recovery.includes(saved.media.ref));
      assert.equal(expired.budget.shared_remaining, before.shared - 1);
    }
    let media = await call(agent, select(saved.media)); assert.equal(media.status, 'ok', JSON.stringify(media));
    const files = [...media.attachmentResults]; while (media.nextCursor) { media = await call(agent, { action: 'next', cursor: media.nextCursor }); files.push(...media.attachmentResults); }
    assert.equal(files.length, 3); assert.ok(files.every(f => f.state === 'accessible' && f.contentRead === false));
    assert.equal(files.find(f => f.type === 'file').path, saved.filePath); assert.equal(files.find(f => f.type === 'file').version.state, 'same');
    assert.equal(files.find(f => f.type === 'image').path, saved.imagePath); assert.equal(files.find(f => f.type === 'image').storage, 'normalized_image');
    assert.equal(files.find(f => f.type === 'path').version.state, 'same');
    const spilled = await call(agent, select(saved.spillItem, 'both')); assert.equal(spilled.status, 'ok'); assert.equal(spilled.attachmentResults[0].path, saved.spill.locator);
    assert.ok(spilled.items.some(i => i.content.includes(saved.spill.locator))); assert.ok(spilled.items.some(i => i.content.includes('needle old preview')));
    let partial;
    if (mode === 'relocate') {
      assert.notEqual(ctx.spillStore.root, join(process.env.DSH_HOME, 'old-spills'));
      const fresh = await ctx.spillStore.saveText({ owner: { sessionId: id }, source: { kind: 'tool', toolName: 'example', callId: 'new-spill', label: 'new' }, suggestedName: 'new.txt', content: 'new output' });
      assert.ok(fresh.locator.startsWith(ctx.spillStore.root)); assert.notEqual(fresh.locator, saved.spill.locator);
      await unlink(saved.filePath); await unlink(saved.spill.locator);
      partial = await call(agent, { action: 'read', ref: saved.media.ref, target: 'both', attachments: saved.media.attachments.filter(a => a.type !== 'path').map(a => a.ref) });
      assert.equal(partial.attachmentResults.find(f => f.type === 'file').state, 'missing'); assert.equal(partial.attachmentResults.find(f => f.type === 'image').state, 'accessible');
      assert.equal(partial.sourceComplete, false);
      const missingSpill = await call(agent, select(saved.spillItem, 'both')); assert.equal(missingSpill.attachmentResults[0].state, 'missing'); assert.equal(missingSpill.sourceComplete, false); assert.ok(missingSpill.items.some(i => i.content.includes('needle old preview')));
    }
    await writeFile(join(root, `${mode}-evidence.json`), JSON.stringify({ mode, pid: process.pid, root: ctx.spillStore.root, pending, files, expired: expired?.budget, before, after: ctx.recallBudget.state(currentInteraction(agent.session)), oldSpill: spilled, partial }, null, 2));
    console.log(`PASS: ${mode} preserves source paths, aged spill, hash limits/baselines and interaction budget; old cursor expires explicitly`);
  }
  await h.dispose(); await runtime.shutdown.shutdown(0);
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
