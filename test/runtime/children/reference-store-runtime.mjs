import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { RecallReferenceStore } from '../../../lib/index.js';
import { referenceFixture } from '../../../support/fixtures/reference.mjs';
import { verifyReferenceStore } from '../../state/reference-store-native.mjs';
import { replace } from '../../../support/fixtures/control.mjs';

const timer = setTimeout(() => process.exit(1), 55000);
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('reference-store', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, [mode, phase] = process.argv[3].split(':'), signal = new AbortController().signal;
  if (mode === 'suite') await verifyReferenceStore(ctx);
  else {
    const locator = referenceFixture(`crash-${phase}`), path = join(process.env.DSH_HOME, '..', `reference-${phase}.json`);
    let candidate;
    async function checkpoint() {
      await fs.writeFile(path, JSON.stringify({ candidate, pid: process.pid }));
      process.send({ phase, pid: process.pid }); await new Promise(() => {});
    }
    if (mode === 'crash') {
      const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv);
      replace(backend.kv, 'open', async descriptor => {
        const unit = await open(descriptor);
        if (/^dsh_recall_references_[a-f0-9]{2}$/.test(descriptor.name)) {
          const put = unit.putRecord.bind(unit);
          replace(unit, 'putRecord', async (table, key, value) => {
            candidate = structuredClone(value); if (phase === 'before-write') await checkpoint();
            await put(table, key, value); if (phase === 'mapped') await checkpoint();
          });
        }
        return unit;
      });
      if (phase === 'temp-synced') {
        const openFile = fs.open.bind(fs);
        fs.open = async (path, ...args) => {
          const handle = await openFile(path, ...args);
          if (/\/dsh_recall_references_[a-f0-9]{2}\/records\//.test(String(path).replaceAll('\\', '/')) && String(path).endsWith('.tmp')) {
            const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); await checkpoint(); };
          }
          return handle;
        };
        syncBuiltinESMExports();
      }
      await ctx.plugin(RecallReferenceStore); await ctx.recallReferences.issue(locator, signal);
      throw new Error('Expected reference crash checkpoint');
    }
    await ctx.plugin(RecallReferenceStore);
    const saved = JSON.parse(await fs.readFile(path, 'utf8')); assert.notEqual(saved.pid, process.pid);
    if (phase === 'mapped') assert.deepEqual(ctx.recallReferences.resolve(saved.candidate.handle, locator.sessionId), saved.candidate);
    else assert.throws(() => ctx.recallReferences.resolve(saved.candidate.handle, locator.sessionId), e => e.code === 'stale_reference');
    const issued = await ctx.recallReferences.issue(locator, signal);
    if (phase === 'mapped') assert.equal(issued.handle, saved.candidate.handle);
    assert.deepEqual(ctx.recallReferences.resolve(issued.handle, locator.sessionId), issued);
    await fs.writeFile(join(process.env.DSH_HOME, '..', `reference-recovered-${phase}.json`), JSON.stringify({ phase, sourcePid: saved.pid, recoveredPid: process.pid, published: phase === 'mapped', stableMapping: phase === 'mapped', newReferenceVerified: true }, null, 2));
    console.log(`PASS: reference ${phase} crash publication and independent-process recovery`);
  }
  await runtime.shutdown.shutdown(0);
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
