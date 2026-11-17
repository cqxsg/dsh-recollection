import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectRoot } from '../../support/paths.mjs';
import { isolatedEnvironment } from '../../support/isolation.mjs';
import { runTrialProcess } from '../../support/process.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] !== '--runtime') {
  assert.ok(process.argv[2], 'Pass the candidate tarball path');
  const tarball = resolve(process.argv[2]), bytes = await readFile(tarball);
  const run = await isolatedEnvironment('recall-command-installed');
  const evidence = { kind: 'installed-package', tarball, sha256: hash(bytes), root: run.root };
  await writeFile(join(run.root, 'installation.json'), JSON.stringify(evidence, null, 2));
  console.log(`Isolated installation: ${run.root}`);
  const installed = await runTrialProcess({ args: [join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'plugin', '--profile', 'web', 'add', tarball], cwd: run.cwd, env: run.env,
    logPath: join(run.root, 'install.log'), watchdogMs: 300000 });
  assert.equal(installed.code, 0, `Installation failed; see ${run.root}`);
  const runtime = await runTrialProcess({ args: [fileURLToPath(import.meta.url), '--runtime', run.root], cwd: run.cwd, env: run.env,
    logPath: join(run.root, 'runtime.log'), watchdogMs: 300000 });
  assert.equal(runtime.code, 0, `Installed smoke failed; see ${run.root}`);
  console.log(`PASS: installed /recall search/read and Chat presentation; evidence ${join(run.root, 'evidence.json')}`);
} else {
  const root = process.argv[3], profile = join(process.env.DSH_HOME, 'profiles/web');
  const localRequire = createRequire(join(profile, 'package.json'));
  const installedEntry = await realpath(localRequire.resolve('dsh-recollection'));
  const rel = relative(profile, installedEntry);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Product resolves inside isolated installed profile');
  const installed = await import(pathToFileURL(installedEntry).href);
  const pkg = JSON.parse(await readFile(localRequire.resolve('dsh-recollection/package.json'), 'utf8'));
  const profilePackage = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(profilePackage.dsh.profile.bundles.includes('dsh-recollection'));
  const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot');
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot');
  const { setSandboxMode } = await import('@deepseek-ai/dsh-sandbox-policy');
  const { recallHarness } = await import('../../support/fixtures/recall-harness.mjs');
  const { waitForRecall } = await import('../../support/wait-for-recall.mjs');
  const overlay = join(root, 'runtime.patch.json');
  await writeFile(overlay, JSON.stringify([
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { id: 'session-title-llm', disabled: true }, { id: 'llm-retry', disabled: true },
    { insert: [{ id: 'recall-test-probe', name: new URL('../fixtures/browser-probe/index.mjs', import.meta.url).href }] },
  ]));
  const runtime = await runProfile({ environment: loadLayeredEnv('installed-recall-command'), profile: 'web', patchFiles: [overlay],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  let h, off;
  try {
    const ctx = runtime.ctx;
    const entries = [...ctx.loader.entries()].filter(e => e.options.id === 'recall');
    assert.equal(entries.length, 1); assert.equal(entries[0].options.name, pkg.name);
    await entries[0].fiber.await(); await waitForRecall(ctx);
    assert.ok(ctx.recallTools instanceof installed.RecallToolsService, 'Runtime uses installed product class');
    assert.ok(ctx.clientModules.graph().entries.some(e => e.id === pkg.name));
    const requests = [];
    // Observe before the scripted provider middleware consumes the request.
    off = ctx.on('llm/stream', async function* (options, next) { requests.push(structuredClone(options.messages)); yield* next(); });
    h = recallHarness(ctx);
    const { agent } = await h.seed('installed-command', ['needle original package evidence']);
    setSandboxMode(agent.session, 'read-only');
    const result = id => {
      const msg = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === id)?.data.message;
      assert.ok(msg); assert.ok(!msg.isError); return JSON.parse(msg.content[0].text);
    };
    h.model.replies.push({ calls: [{ id: 'installed-search', name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }] },
      { calls: [{ id: 'installed-read', name: 'recall_read', args: { action: 'read', get ref() { return result('installed-search').items[0].ref; } } }] }, {});
    assert.ok(ctx.commands.find(agent, 'recall').input.hint);
    assert.equal((await ctx.commands.execute(agent, '/recall', [], new AbortController().signal)).result.kind, 'success');
    await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    assert.equal(h.model.replies.length, 0);
    assert.equal(result('installed-search').totalHits, 1);
    assert.equal(result('installed-read').readComplete, true);
    const inputs = agent.session.snapshotEvents().filter(e => e.type === 'user/message'
      && e.data.source.dshRecollection?.type === 'recall');
    assert.equal(inputs.length, 1); assert.ok(agent.session.surface.nodes.includes(inputs[0].seq));
    assert.deepEqual(inputs[0].data.source, { kind: 'user', dshRecollection: { type: 'recall', userInput: '' } });
    assert.match(inputs[0].data.content[0].text, /If you cannot identify a concrete historical recall target/);
    assert.ok(Object.values(ctx.sessionProjections.snapshot(agent.session).values.recallCommandPreviews).includes(''));
    assert.equal(requests.length, 3);
    assert.ok(JSON.stringify(requests.at(-1)).includes('needle original package evidence'));
    assert.equal(ctx.recallBudget.records().find(r => r.interactionId === inputs[0].data.id).shared, 10);
    const evidence = { ...JSON.parse(await readFile(join(root, 'installation.json'), 'utf8')), version: pkg.version,
      installedEntry, installedEntrySha256: hash(await readFile(installedEntry)), loaderName: entries[0].options.name,
      installedClassVerified: true, clientDiscovered: true, markedModelRequest: true, requestCount: inputs.length,
      searchHits: 1, readComplete: true, evidenceDelivered: true, sharedRemaining: 10, passed: true };
    await off(); off = undefined; await h.dispose(); h = undefined;
    // The probe only exposes the runtime for assertions; product Host and Client
    // continue to resolve by installed package name, never a source URL overlay.
    const { verifyRecallCommandBrowser } = await import('../client/recall-command-browser.mjs');
    await verifyRecallCommandBrowser(ctx, `http://127.0.0.1:${ctx.webServer.port}/`);
    const browserEvidence = join(root, 'command-browser-evidence.json');
    const browser = JSON.parse(await readFile(browserEvidence, 'utf8'));
    assert.equal(browser.passed, true);
    evidence.browser = { evidence: browserEvidence, cases: browser.cases, pageErrors: browser.pageErrors,
      submissions: browser.submissions.length, requests: browser.requests.length, browser: browser.browser };
    // Native installation must preserve every byte recorded in the delivery manifest.
    const { dirname } = await import('node:path');
    const manifestPath = join(dirname(evidence.tarball), 'build-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.archive.sha256, evidence.sha256); assert.equal(manifest.version, pkg.version);
    const packageRoot = dirname(localRequire.resolve('dsh-recollection/package.json'));
    for (const file of manifest.files) assert.equal(hash(await readFile(join(packageRoot, file.path))), file.sha256, file.path);
    evidence.installedFilesVerified = manifest.files.length;
    evidence.sourceCommit = manifest.source.commit;
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  } finally { await off?.(); await h?.dispose(); await runtime.shutdown.shutdown(0); }
}
