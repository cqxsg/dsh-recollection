import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { RecallHashLedger, loadRecallConfig, hashKey, HASH_CHUNK_BYTES, HASH_SLICE_MS } from '../../../lib/index.js';

const timer = setTimeout(() => process.exit(1), 40000); let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-hash-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, [mode, phase] = process.argv[3].split(':'), id = `hash-${phase}`;
  const path = join(process.cwd(), `${id}.bin`), bytes = Buffer.alloc(HASH_CHUNK_BYTES * 2 + 3, 18);
  const source = { sessionId: id, seq: 0, messageId: id, block: 0, selector: 'p0:0', fingerprint: 'source', referenceText: `@${path}`, path, recordedAt: 1234 }, key = hashKey(source);
  let reads = 0; const read = ctx.fs.readByteRange;
  ctx.fs.readByteRange = async function(...args) { reads++; return read.apply(this, args); };
  if (mode === 'crash') {
    await writeFile(path, bytes);
    const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv);
    backend.kv.open = async descriptor => {
      const unit = await open(descriptor);
      if (descriptor.name === 'dsh_recall_hashes') {
        const put = unit.putRecord.bind(unit);
        unit.putRecord = async (table, k, value) => {
          await put(table, k, value);
          if (k === key && (phase === 'registered' && value.attempts === 0 || ['reserved', 'exhausted'].includes(phase) && value.reserved || phase === 'saved' && value.state === 'saved')) {
            process.send({ phase, reads, pid: process.pid, value }); await new Promise(() => {});
          }
        };
      }
      return unit;
    };
  }
  const options = loadRecallConfig(mode === 'recover' ? { hashAttempts: 8, hashActiveMs: 90000 } : phase === 'exhausted' ? { hashAttempts: 1 } : {});
  let fiber = await ctx.plugin(RecallHashLedger, options);
  if (mode === 'crash') {
    await ctx.recallHashes.register(source);
    for (let i = 0; i < 10; i++) {
      const row = await ctx.recallHashes.step(key);
      if (phase === 'paused') { process.send({ phase, reads, pid: process.pid, value: row }); await new Promise(() => {}); }
    }
    assert.fail('parent must kill the process');
  } else {
    const recovered = ctx.recallHashes.get(key);
    assert.deepEqual(recovered.limits, { attempts: phase === 'exhausted' ? 1 : 2, activeMs: 15000 });
    assert.equal(recovered.reserved, undefined);
    if (['reserved', 'exhausted'].includes(phase)) assert.equal(recovered.spentMs, HASH_SLICE_MS);
    await fiber.dispose(); fiber = await ctx.plugin(RecallHashLedger, options);
    assert.deepEqual(ctx.recallHashes.get(key), recovered, 'a second reload must not charge the unsettled slice twice');
    let final = recovered;
    while (!['saved', 'failed'].includes(final.state)) final = await ctx.recallHashes.step(key);
    if (phase === 'exhausted') { assert.equal(final.state, 'failed'); assert.equal(reads, 0); }
    else {
      assert.equal(final.state, 'saved'); assert.equal(final.sample.hash, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(final.attempts, ['reserved', 'paused'].includes(phase) ? 2 : 1);
      if (phase === 'saved') { assert.equal(reads, 0); assert.deepEqual(final, recovered); }
    }
    await writeFile(join(process.env.DSH_HOME, '..', `${phase}-recovered.json`), JSON.stringify({ recovered, final, reads, pid: process.pid }, null, 2));
    console.log(`PASS: hash ${phase} recovery preserves task limits, reservations and immutable baseline`);
  }
  await fiber.dispose(); await runtime.shutdown.shutdown(0);
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
