import { projectRoot } from '../../support/paths.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isolatedEnvironment } from '../../support/isolation.mjs';
import { waitForRecall } from '../../support/wait-for-recall.mjs';

if (!process.argv.includes('--runtime')) {
  const run = await isolatedEnvironment('candidate-config');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--runtime', run.root], {
    cwd: run.cwd, env: run.env, stdio: 'inherit', windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  process.exitCode = code ?? 1;
} else {
  // This is a source/configuration check, not installation acceptance.
  const { loadOverlayPatches, composeEntries, loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot');
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot');
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const layer = join(projectRoot, pkg.dsh.bundle.patch);
  const patches = loadOverlayPatches('candidate-config', layer);
  const base = [{ insert: [{ id: 'spill-local', name: '@deepseek-ai/dsh-spill-local' }] }];
  const composed = composeEntries([base, patches], message => { throw new Error(message); });
  const recall = composed.find(row => row.id === 'recall');
  assert.equal(recall.name, pkg.name);
  assert.deepEqual(recall.config, { enabled: true, diagnostics: false });
  const resolvedPlugin = import.meta.resolve(recall.name);
  assert.equal(resolvedPlugin, new URL('../../lib/index.js', import.meta.url).href);
  // Patch `name` fields are assertions in rc.4, not replacements. Resolve the
  // inserted row in a test-only copy before loading; keep shipped config intact.
  const sourcePatches = structuredClone(patches);
  sourcePatches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'recall').name = resolvedPlugin;
  const sourceLayer = join(process.argv[3], 'source-layer.patch.json');
  await writeFile(sourceLayer, JSON.stringify(sourcePatches));
  const evidence = { kind: 'source-configuration-only', installedPackage: false, cases: [] };
  const timeout = setTimeout(() => { console.error('Candidate config check timed out'); process.exit(1); }, 120_000);
  try {
    for (const scenario of ['default', 'custom-root', 'disabled']) {
      const customRoot = join(process.env.DSH_HOME, 'user-spills');
      const override = [
        ...(scenario === 'disabled' ? [{ id: 'recall', disabled: true }] : []),
        { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
        ...(scenario === 'custom-root' ? [{ id: 'spill-local', config: { root: customRoot, cleanupPeriodDays: 0 } }] : []),
      ];
      const overlay = join(process.argv[3], `${scenario}.patch.json`);
      await writeFile(overlay, JSON.stringify(override));
      const runtime = await runProfile({ environment: loadLayeredEnv('candidate-config'), profile: 'web',
        patchFiles: [sourceLayer, overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
      try {
        const { ctx } = runtime;
        if (scenario !== 'disabled') {
          // Web startup can precede the plugin's asynchronous storage/tool activation.
          const entry = [...ctx.loader.entries()].find(row => row.options.id === 'recall');
          assert.ok(entry, 'Configured recall plugin must have a Loader entry');
          await entry.fiber.await();
          await waitForRecall(ctx);
        }
        assert.equal(ctx.spillStore.root, scenario === 'custom-root' ? customRoot : join(process.env.DSH_HOME, 'spills'));
        assert.equal(ctx.spillStore.config.cleanupPeriodDays, 0);
        assert.equal(Boolean(ctx.get('recallHost')), scenario !== 'disabled');
        for (const tool of ['recall_search', 'recall_read']) assert.equal(Boolean(ctx.tools.get(tool)), scenario !== 'disabled');
        assert.equal(ctx.get('recallDiagnostics'), undefined);
        assert.equal(ctx.clientModules.graph().entries.some(row => row.id === pkg.name), scenario !== 'disabled');
        evidence.cases.push({ scenario, root: scenario === 'custom-root' ? '<DSH_HOME>/user-spills' : '<DSH_HOME>/spills',
          cleanupPeriodDays: 0, formalTools: scenario !== 'disabled', clientDiscovered: scenario !== 'disabled', diagnostics: false });
        console.log(`PASS: candidate layer ${scenario}: spill, formal tools, Client discovery and diagnostics`);
      } finally { await runtime.shutdown.shutdown(0); }
    }
    await writeFile(join(process.argv[3], 'config-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Candidate config evidence: ${process.argv[3]}`);
  } finally { clearTimeout(timeout); }
}
