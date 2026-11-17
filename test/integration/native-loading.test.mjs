import { projectRoot } from '../../support/paths.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { boot } from '@deepseek-ai/dsh-app-boot';
import { resolveDshHome, resolveAgentsHome } from '@deepseek-ai/dsh-home-paths';

const root = projectRoot;
const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

test('core import does not resolve the optional commands package', async () => {
  const url = new URL('../../lib/index.js?command-package-absent', import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === url && specifier === '@deepseek-ai/dsh-commands') throw new Error('Core requires the optional commands package');
    return next(specifier, context);
  } });
  try { assert.equal(typeof (await import(url)).apply, 'function'); } finally { hooks.deregister(); }
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-commands'].optional, true);
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh-commands'], '0.2.1-rc.4');
});

test('rc.4 dependency baseline and isolated data roots', async () => {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(path)) assert.equal(dependency.version, '0.2.1-rc.4', path);
  }
  assert.equal(resolveDshHome(), process.env.DSH_HOME);
  assert.equal(resolveAgentsHome(), process.env.DSH_AGENTS_HOME);
  for (const path of [resolveDshHome(), resolveAgentsHome(), process.cwd()]) {
    const local = relative(join(root, '.local', 'tests'), path);
    assert.ok(local && !local.startsWith('..'), 'Unisolated test path: ' + path);
  }
});

test('native Host loader registers generated contracts, serves Client and reloads its scope', async t => {
  const entries = JSON.parse(await readFile(new URL('../fixtures/cordis.json', import.meta.url), 'utf8'));
  for (const entry of entries) entry.name = import.meta.resolve(entry.name);
  const config = join(process.cwd(), 'cordis.json');
  await writeFile(config, JSON.stringify(entries));
  const ctx = await boot('recall-smoke', config);
  t.after(() => ctx.fiber.dispose());
  assert.equal(ctx.recallPages.status.implementation, 'phase-5-evaluation');
  assert.equal(ctx.get('recallDiagnostics'), undefined);
  assert.equal(ctx.get('recallLedger'), undefined);
  assert.equal(ctx.recallPages.status.recallAvailable, false);
  assert.ok(ctx.typert.getPackage(pkg.name, 'host'));
  const graph = ctx.clientModules.graph();
  assert.equal(graph.release.version, '0.2.1-rc.4');
  assert.equal(ctx.clientModules.clientPath(pkg.name), join(root, 'lib', 'client.js'));
  const row = graph.entries.find(row => row.id === pkg.name);
  const response = await ctx.clientModules.fetchBundle(new Request(new URL(row.url, 'http://localhost/')));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /window\.__ModuleLoader__\.load/);
  const missing = await ctx.clientModules.fetchBundle(new Request('http://localhost/plugins/missing.js'));
  assert.equal(missing.status, 404);
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'recall');
  const previous = ctx.recallPages.pages;
  await entry.fiber.restart();
  assert.ok(ctx.recallHost);
  assert.notEqual(ctx.recallPages.pages, previous);
  assert.ok(ctx.typert.getPackage(pkg.name, 'host'));
  await ctx.fiber.dispose();
  assert.equal(ctx.get('recallPages'), undefined);
  assert.equal(ctx.get('clientModules'), undefined);
});
