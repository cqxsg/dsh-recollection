import { launchWeb } from '../../support/web-launch.mjs';
import { readWebOptions, webPatch } from './web-scenarios.mjs';

await launchWeb({ label: 'review-0.2.1', persistent: false,
  nodeArgs: process.argv.some(a => a.startsWith('--host-root=') || a.startsWith('--plugin-root='))
    ? ['--import', new URL('../../support/repair-host-loader.mjs', import.meta.url).href] : [],
  patch: [...webPatch(readWebOptions(['--smoke'])),
    { id: 'spill-policy', config: { maxInlineTokens: 2500 } },
    { id: 'tool-fs-search', config: { globMaxResults: 2, grepMaxMatches: 2 } }],
  args: ['--smoke', '--repair-review', ...process.argv.slice(2)],
});
