import { projectRoot } from '../../support/paths.mjs';
// Independent CLI reference lives outside product src/lib and is never packaged.
import { build } from 'esbuild';
await build({ absWorkingDir: projectRoot, entryPoints: ['test/reference/cli-matcher.ts'],
  outfile: '.local/cli-matcher.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
await build({ absWorkingDir: projectRoot, entryPoints: ['test/reference/records.ts'],
  outfile: '.local/records-reference.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
