import { projectRoot } from '../../support/paths.mjs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Only remove this project's generated lib directory, never a redirected target.
const root = await realpath(projectRoot);
const output = join(root, 'lib');
try {
  const info = await lstat(output);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(output)) !== output) {
    throw new Error(`Refusing to clean a redirected or non-directory build output: ${output}`);
  }
  await rm(output, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
