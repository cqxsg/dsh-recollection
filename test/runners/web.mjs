import { launchWeb } from '../../support/web-launch.mjs';
import { readWebOptions, webLabel, webPatch, webArguments } from './web-scenarios.mjs';

const options = readWebOptions(['--smoke', ...process.argv.slice(2)]);
if (options.records) await import('../reference/build-reference.mjs');
await launchWeb({ label: webLabel(options), persistent: false, patch: webPatch(options), args: webArguments(options) });
