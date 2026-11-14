import { launchWeb } from '../../support/web-launch.mjs';

await launchWeb({ patch: [
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { diagnostics: false, enabled: true } }] },
] });
