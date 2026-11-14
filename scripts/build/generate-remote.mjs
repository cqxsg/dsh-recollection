import { projectRoot } from '../../support/paths.mjs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTypertGenerator, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator';

const root = projectRoot;
const scratch = join(root, '.local', 'typert');
await mkdir(scratch, { recursive: true });
// rc.4 requires a packages/ workspace. Stage this one package for analysis;
// the real source/package layout and all runtime artifacts stay independent.
const workspace = await mkdtemp(join(scratch, 'run-'));
const staged = join(workspace, 'packages', 'recall');
await mkdir(staged, { recursive: true });
await cp(join(root, 'src'), join(staged, 'src'), { recursive: true });
// Its decorator analyzer recognizes protocol symbols only in registered
// workspace packages. Register the unmodified published declarations as well.
const protocolRoot = join(workspace, 'packages', 'protocol');
const installedProtocol = join(root, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol');
await mkdir(protocolRoot, { recursive: true });
await cp(join(installedProtocol, 'lib', 'types'), join(protocolRoot, 'declarations'), { recursive: true });
const protocolManifest = JSON.parse(await readFile(join(installedProtocol, 'package.json'), 'utf8'));
protocolManifest.exports = {
  '.': './declarations/index.d.ts',
  './types': './declarations/types.d.ts',
  './remote-info': './declarations/remote-info.d.ts',
};
await writeFile(join(protocolRoot, 'package.json'), JSON.stringify(protocolManifest));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.exports = {
  '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
  './types': { types: './lib/types/shared/view-protocol.d.ts' },
  './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
  './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
};
delete manifest.dsh.client;
await writeFile(join(staged, 'package.json'), JSON.stringify(manifest));
// Analyze only the public Host service, before generated imports exist.
await writeFile(join(staged, 'src', 'index.ts'), "export { RecallHostService } from './host/service.js';\n");
const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
config.compilerOptions.outDir = 'lib/types';
config.compilerOptions.paths = {
  '@deepseek-ai/dsh-typert-protocol': [join(protocolRoot, 'declarations', 'index.d.ts')],
  '@deepseek-ai/dsh-typert-protocol/*': [join(protocolRoot, 'declarations', '*')],
};
config.include = ['src/index.ts'];
const dependencies = [];
for (const name of ['dsh-session', 'dsh-brand']) {
  const dependencyRoot = join(workspace, 'packages', name);
  const installed = join(root, 'node_modules', '@deepseek-ai', name);
  const dependency = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  await mkdir(dependencyRoot, { recursive: true });
  await cp(join(installed, 'lib', 'types'), join(dependencyRoot, 'declarations'), { recursive: true });
  dependency.exports = Object.fromEntries(Object.entries(dependency.exports).flatMap(([key, value]) => {
    const types = typeof value === 'object' ? value.types : undefined;
    return types?.startsWith('./lib/types/') ? [[key, types.replace('./lib/types/', './declarations/')]] : [];
  }));
  await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify(dependency));
  for (const [key, value] of Object.entries(dependency.exports)) {
    config.compilerOptions.paths[dependency.name + (key === '.' ? '' : key.slice(1))] = [join(dependencyRoot, value)];
  }
  dependencies.push(dependencyRoot);
}
await writeFile(join(staged, 'tsconfig.host.json'), JSON.stringify(config));
await writeFile(join(protocolRoot, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: config.compilerOptions, include: ['declarations/**/*.d.ts'] }));
for (const dependencyRoot of dependencies) await writeFile(join(dependencyRoot, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: config.compilerOptions, include: ['declarations/**/*.d.ts'] }));
await writeFile(join(workspace, 'tsconfig.host.json'), JSON.stringify({
  compilerOptions: config.compilerOptions,
  files: [], references: [{ path: './packages/recall/tsconfig.host.json' }, { path: './packages/protocol/tsconfig.host.json' }, ...dependencies.map(path => ({ path: join(path, 'tsconfig.host.json') }))],
}));
const artifacts = new WorkspaceTypertGenerator(workspace).generate([manifest.name], ['host']);
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Expected one generated Host and Remote contract.');
writePackageArtifacts(root, artifacts);
console.log('Generated rc.4 Host and Client Remote contracts.');
