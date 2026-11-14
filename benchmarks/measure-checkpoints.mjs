import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointWriter } from '../support/checkpoint.mjs';

const { values } = parseArgs({ options: { input: { type: 'string', multiple: true }, repeats: { type: 'string', default: '30' } } });
const repeats = Number(values.repeats);
if (!values.input?.length || !Number.isSafeInteger(repeats) || repeats < 30 || repeats > 1000) throw new Error('Use --input result.json [--input result.json ...] --repeats 30..1000');
const base = fileURLToPath(new URL('../.local/checkpoint-cost/', import.meta.url));
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, 'run-')), samples = [];
for (const [index, input] of values.input.entries()) {
  const bytes = await readFile(input), value = JSON.parse(bytes), write = checkpointWriter(join(root, `snapshot-${index}.json`));
  const rows = [];
  await write(value); // Separate warm-up: no file creation in measured overwrites.
  for (let repeat = 0; repeat < repeats; repeat++) {
    let start = performance.now(); const serialized = JSON.stringify(value, null, 2); const serializeMs = performance.now() - start;
    start = performance.now(); await write(value); const serializeWriteRenameMs = performance.now() - start;
    rows.push({ repeat, bytes: Buffer.byteLength(serialized), serializeMs, serializeWriteRenameMs });
  }
  samples.push({ input: resolve(input), inputSha256: createHash('sha256').update(bytes).digest('hex'), rows });
}
const output = join(root, 'result.json');
await writeFile(output, JSON.stringify({ protocol: 'dsh-checkpoint-cost-v1', node: process.version, repeats,
  definition: 'Separate microbenchmark over captured payloads, not in-trial attribution. Full writer latency includes serialization, queued async write and rename; storage is not flushed to physical disk. No subtraction claims exact I/O time.', samples }, null, 2));
console.log(output);
