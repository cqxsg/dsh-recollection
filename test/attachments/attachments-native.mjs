import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice';
import { fileMentions, blockAttachments, recordAttachments, attachmentMetadata, accessAttachment, HistoryRecordCache, attachmentResult, recallResult, nativeSchema, renderedTokens, verifyOutput } from '../../lib/index.js';
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, text } from '../../support/fixtures/range.mjs';
import { fixturePng } from '../fixtures/image.mjs';

export async function verifyAttachments(ctx) {
  const cases = [], signal = new AbortController().signal;
  const check = async (name, fn) => { await fn(); cases.push(name); console.log(`PASS: ${name}`); };
  const root = join(process.cwd(), 'file sources'); await mkdir(root, { recursive: true });
  const path = join(root, '历史 note.txt'); await writeFile(path, 'version one');
  const file = await ctx.attachments.saveFile({ data: Buffer.from('archived original'), name: 'original.pdf' });
  const image = await ctx.attachments.saveImage({ data: fixturePng(), mediaType: 'image/png' });
  const spill = await ctx.spillStore.saveText({ owner: { sessionId: 'attachments-foundation' }, source: { kind: 'tool', toolName: 'example', callId: 'spill-call', label: 'result' }, suggestedName: 'old.txt', content: 'full spilled result' });
  await check('native file mention grammar preserves exact Unicode, quotes and per-occurrence positions', () => {
    const body = 'email a@b.invalid @one.txt @"历史 note.txt" @one.txt';
    const refs = fileMentions(body);
    assert.deepEqual(refs.map(r => r.path), ['one.txt', '历史 note.txt', 'one.txt']);
    for (const ref of refs) assert.equal(body.slice(ref.offset, ref.offset + ref.original.length), ref.original);
    assert.notEqual(refs[0].offset, refs[2].offset);
    assert.equal(fileMentions('@"unfinished name').length, 0);
    assert.equal(blockAttachments(text('@x'), 0, 'assistant', 'message').length, 0);
    assert.equal(blockAttachments({ type: 'tool-call', name: 'read', id: 'c', arguments: '{"path":"relative.txt"}' }, 3, 'assistant', 'tool_call')[0].path, 'relative.txt');
  });
  await check('archived file, normalized image and old spill use native execution paths without copies', async () => {
    for (const [type, attachment, expected] of [['file', file, ctx.attachments.fileHostPath(file)], ['image', image, ctx.attachments.imageHostPath(image)]]) {
      const source = blockAttachments({ type, attachment }, 0, 'user', 'message')[0];
      const result = await accessAttachment(ctx, source, undefined, signal);
      assert.equal(result.state, 'accessible'); assert.equal(result.path, expected);
    }
    const source = blockAttachments(text(formatSpillNotice({ kind: 'exact', count: 100 }, spill)), 0, 'tool', 'tool_result')[0];
    assert.equal(source.path, spill.locator); assert.equal(source.metadata.authenticatedContent, false);
    assert.equal((await accessAttachment(ctx, source, undefined, signal)).path, spill.locator);
    assert.equal(blockAttachments(text(formatSpillNotice({ kind: 'exact', count: 100 }, spill)), 0, 'assistant', 'message').length, 0);
  });
  await check('relative paths use historical cwd and access failures never claim a readable path', async () => {
    const source = blockAttachments(text('@"历史 note.txt"'), 0, 'user', 'message')[0];
    assert.equal((await accessAttachment(ctx, source, root, signal)).path, path);
    assert.equal((await accessAttachment(ctx, source, undefined, signal)).state, 'unresolved');
    assert.equal((await accessAttachment(ctx, { ...source, path: 'missing.txt' }, root, signal)).state, 'missing');
    assert.equal((await accessAttachment(ctx, { ...source, path: root }, undefined, signal)).state, 'not_file');
    const original = ctx.fs.readByteRange;
    ctx.fs.readByteRange = async () => { throw Object.assign(new Error('denied'), { code: 'FS_PERMISSION_DENIED' }); };
    try { const result = await accessAttachment(ctx, source, root, signal); assert.equal(result.state, 'permission_denied'); assert.equal(result.path, undefined); }
    finally { ctx.fs.readByteRange = original; }
    const mapping = ctx.fs.processPathFromHostPath; ctx.fs.processPathFromHostPath = () => undefined;
    try { assert.equal((await accessAttachment(ctx, blockAttachments({ type: 'file', attachment: file }, 0, 'user', 'message')[0], root, signal)).state, 'unreachable'); }
    finally { ctx.fs.processPathFromHostPath = mapping; }
    const aborted = AbortSignal.abort(new Error('cancelled'));
    await assert.rejects(accessAttachment(ctx, source, root, aborted), /cancelled/);
  });
  await check('canonical source metadata is pure, retains old media refs, and never probes files', async () => {
    const f = await createHistoryFixture(ctx, 'attachment-records', []), r = rangeFixture(f.session);
    r.user([text('needle @"file sources/历史 note.txt"'), { type: 'file', attachment: file }, { type: 'image', attachment: image }]);
    r.summary([...f.session.surface.nodes]); await f.flush();
    const cache = new HistoryRecordCache();
    const original = ctx.fs.stat; ctx.fs.stat = async () => { throw new Error('unexpected file probe'); };
    try {
      await ctx.recallHistory.withSnapshot(f.session.id, async (snapshot, scope) => {
        const batch = await cache.prepareBatch(snapshot, ctx.sessions.messageProjections, {}, scope);
        const record = cache.records(batch)[0];
        const sources = recordAttachments(record); assert.deepEqual(sources.map(a => a.type), ['path', 'file', 'image']);
        const metadata = sources.map(a => attachmentMetadata('rr2_' + 'A'.repeat(22), a));
        assert.ok(metadata.every(a => a.state === 'not_checked'));
        assert.ok(metadata[1].ref.endsWith(':a1')); assert.ok(metadata[2].ref.endsWith(':a2'));
        assert.equal(new Set(metadata.map(a => a.ref)).size, 3);
      });
    } finally { ctx.fs.stat = original; cache.dispose(); await f.close(); }
  });
  await check('checked access/version/content-read states validate and all file metadata is output-priced', () => {
    const result = { ref: 'r:a0', sourceRef: 'r', block: 0, type: 'file', state: 'accessible', path, contentRead: false, checkedAt: Date.now(), storage: 'archived_file', version: { state: 'native_identity' } };
    attachmentResult.parse(result);
    assert.throws(() => attachmentResult.parse({ ...result, path: undefined }));
    assert.throws(() => attachmentResult.parse({ ...result, state: 'missing' }));
    assert.throws(() => attachmentResult.parse({ ...result, contentRead: true }));
    assertSupportedJsonSchema(nativeSchema(recallResult));
    const value = { status: 'ok', items: [], attachmentResults: [result], attachmentsComplete: true, textRequested: false,
      budget: { revision: 1, search_remaining: 5, shared_remaining: 10, query_pages_remaining: 0, paid_pages_remaining: 2, actual_calls: 2, closed: false }, allowed_actions: ['read'] };
    verifyOutput(value, 2000); assert.ok(renderedTokens(value) > renderedTokens({ ...value, attachmentResults: [] }));
  });
  const evidence = join(process.env.DSH_HOME, '..', 'attachments-evidence.json');
  await writeFile(evidence, JSON.stringify({ cases, file, image, spill, root }, null, 2)); console.log(`Attachments evidence: ${evidence}`);
}
