import { readFile } from 'node:fs/promises';
import { runTrialRuntime } from '../support/trial-runtime.mjs';
import { processResourceMeter } from './resources.mjs';

const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
await runTrialRuntime(spec, async (ctx, spec, progress) => {
  if (spec.suite === 'capacity') return (await import('./capacity.mjs')).capacityTrial(ctx, spec, progress);
  return spec.suite === 'matrix' ? (await import('./matrix.mjs')).matrixTrial(ctx, spec, progress)
    : (await import('./performance.mjs')).performanceTrial(ctx, spec, progress);
}, processResourceMeter);
