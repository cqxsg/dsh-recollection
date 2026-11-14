import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RecallHashLedger, loadRecallConfig, hashCurrent, hashKey, HASH_CHUNK_BYTES } from '../../lib/index.js';

export async function verifyHashes(ctx) {
  const cases = [], config = loadRecallConfig(), signal = new AbortController().signal;
  const check = async (name, fn) => { await fn(); cases.push(name); console.log(`PASS: ${name}`); };
  const path = join(process.cwd(), 'hash-file.bin'), data = Buffer.alloc(HASH_CHUNK_BYTES * 2 + 7, 13);
  await writeFile(path, data);
  let index = 0, fiber;
  const source = (overrides = {}) => ({ sessionId: 'hash-native', seq: ++index, messageId: `m${index}`, block: 0, selector: 'p0:0', fingerprint: 'original-source', referenceText: '@hash-file.bin', path, cwd: process.cwd(), recordedAt: Date.now(), ...overrides });
  const run = async key => { for (let i = 0; i < 100; i++) { const r = await ctx.recallHashes.step(key); if (['saved', 'failed'].includes(r.state)) return r; } assert.fail('hash task did not terminate'); };
  // Faults are injected into the actual native backend, before domain publication.
  const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv); let failWrite;
  backend.kv.open = async descriptor => {
    const unit = await open(descriptor);
    if (descriptor.name === 'dsh_recall_hashes') {
      const put = unit.putRecord.bind(unit);
      unit.putRecord = async (table, key, value) => { if (failWrite?.(value)) throw new Error('injected hash write failure'); await put(table, key, value); };
    }
    return unit;
  };
  try {
    fiber = await ctx.plugin(RecallHashLedger, config);
    await check('one reference owns one immutable baseline; duplicate registration and pauses do not spend new attempts', async () => {
      const s = source(), key = await ctx.recallHashes.register(s);
      assert.equal(await ctx.recallHashes.register(s), key);
      const first = await ctx.recallHashes.step(key); assert.equal(first.attempts, 1); assert.equal(first.reserved, undefined);
      assert.equal(ctx.recallHashes.bytes(key), HASH_CHUNK_BYTES);
      const pausedAt = first.spentMs; await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(ctx.recallHashes.get(key).spentMs, pausedAt);
      const saved = await run(key); assert.equal(saved.attempts, 1); assert.equal(saved.sample.hash, createHash('sha256').update(data).digest('hex'));
      await writeFile(path, 'modified'); const verified = await hashCurrent(ctx.fs, path, config, signal);
      assert.notEqual(verified.sample.hash, saved.sample.hash); assert.deepEqual(ctx.recallHashes.get(key), saved);
      const next = await ctx.recallHashes.register(source()); assert.notEqual(next, key);
      assert.notEqual((await run(next)).sample.hash, saved.sample.hash);
      await writeFile(path, data);
    });
    await check('changes while paused or during a read discard progress, share T, and use at most N attempts', async () => {
      const key = await ctx.recallHashes.register(source()); await ctx.recallHashes.step(key);
      const spent = ctx.recallHashes.get(key).spentMs;
      await writeFile(path, Buffer.alloc(data.length, 27));
      const changed = await ctx.recallHashes.step(key); assert.equal(changed.state, 'pending'); assert.equal(changed.reason, 'file_changed');
      const saved = await run(key); assert.equal(saved.attempts, 2); assert.ok(saved.spentMs >= spent);
      const unstable = await ctx.recallHashes.register(source());
      const read = ctx.fs.readByteRange; let changes = 0;
      ctx.fs.readByteRange = async function(...args) { const bytes = await read.apply(this, args); await writeFile(path, Buffer.alloc(data.length + ++changes, changes)); return bytes; };
      try { const failed = await run(unstable); assert.equal(failed.state, 'failed'); assert.equal(failed.attempts, 2); assert.equal(failed.reason, 'file_changed'); assert.equal(failed.sample, undefined); }
      finally { ctx.fs.readByteRange = read; await writeFile(path, data); }
    });
    await check('registration and activity-write failures execute no byte read; completion failure never publishes a baseline', async () => {
      const s = source(); failWrite = r => r.source.seq === s.seq;
      await assert.rejects(ctx.recallHashes.register(s), e => e.code === 'hash_write_failed'); assert.equal(ctx.recallHashes.get(hashKey(s)), undefined);
      failWrite = undefined; const key = await ctx.recallHashes.register(s);
      const read = ctx.fs.readByteRange; let reads = 0;
      ctx.fs.readByteRange = async function(...args) { reads++; return read.apply(this, args); };
      try {
        failWrite = r => r.source.seq === s.seq && r.reserved;
        await assert.rejects(ctx.recallHashes.step(key), e => e.code === 'hash_write_failed'); assert.equal(reads, 0); assert.equal(ctx.recallHashes.get(key).attempts, 0);
        failWrite = r => r.source.seq === s.seq && r.state === 'saved';
        await assert.rejects(run(key), e => e.code === 'hash_write_failed'); assert.equal(ctx.recallHashes.get(key).sample, undefined); assert.ok(ctx.recallHashes.get(key).reserved);
        const before = ctx.recallHashes.get(key); failWrite = undefined;
        const after = await run(key); assert.equal(after.attempts, 2); assert.ok(after.spentMs >= before.spentMs + before.reserved.ms); assert.equal(after.state, 'saved');
      } finally { failWrite = undefined; ctx.fs.readByteRange = read; }
    });
    await check('reload restarts unfinished work with original limits, charges outstanding reservations once, and preserves saved/failed tasks', async () => {
      const key = await ctx.recallHashes.register(source()); await ctx.recallHashes.step(key); const before = ctx.recallHashes.get(key);
      const missing = await ctx.recallHashes.register(source({ path: join(process.cwd(), 'absent') })); assert.equal((await run(missing)).state, 'failed');
      const saved = ctx.recallHashes.records().find(r => r.state === 'saved');
      await fiber.dispose(); fiber = await ctx.plugin(RecallHashLedger, loadRecallConfig({ hashAttempts: 9, hashActiveMs: 90000 }));
      assert.equal(ctx.recallHashes.get(key).attempts, 1); assert.equal(ctx.recallHashes.get(key).spentMs, before.spentMs);
      const done = await run(key); assert.equal(done.attempts, 2); assert.deepEqual(done.limits, { attempts: 2, activeMs: 15000 });
      assert.deepEqual(ctx.recallHashes.get(hashKey(saved.source)), saved); assert.equal((await ctx.recallHashes.step(missing)).state, 'failed');
    });
    await check('active time includes slow read I/O, excludes pauses, respects outer cancellation and never accepts a partial digest', async () => {
      const read = ctx.fs.readByteRange;
      ctx.fs.readByteRange = async (...args) => {
        const s = args[2]; await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000), abort = () => { clearTimeout(timer); reject(s.reason); };
          s.addEventListener('abort', abort, { once: true }); if (s.aborted) abort();
        }); return read.apply(ctx.fs, args);
      };
      try {
        const timed = await hashCurrent(ctx.fs, path, { hashAttempts: 2, hashActiveMs: 35 }, signal);
        assert.equal(timed.reason, 'hash_time_exhausted'); assert.equal(timed.sample, undefined); assert.equal(timed.attempts, 1); assert.ok(timed.spentMs >= 30);
        const abort = new AbortController(); const pending = hashCurrent(ctx.fs, path, config, abort.signal); setTimeout(() => abort.abort(new Error('outer cancelled')), 20);
        await assert.rejects(pending, /outer cancelled/);
      } finally { ctx.fs.readByteRange = read; }
    });
    const output = join(process.env.DSH_HOME, '..', 'hash-evidence.json');
    await writeFile(output, JSON.stringify({ cases, records: ctx.recallHashes.records() }, null, 2)); console.log(`Hash evidence: ${output}`);
  } finally { failWrite = undefined; await fiber?.dispose(); backend.kv.open = open; }
}
