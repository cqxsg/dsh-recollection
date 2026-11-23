import { registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test-only host/package selection. Runs after launchWeb isolates homes and cwd.
// Never edits an installed host, its profile, or the development dependency lock.
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const host = option('host-root'), plugin = option('plugin-root');
const parentURL = host && pathToFileURL(join(realpathSync(host), 'package.json')).href;
const development = new URL('../lib/index.js', import.meta.url).href;
const candidate = plugin && pathToFileURL(join(realpathSync(plugin), 'lib/index.js')).href;
if (host) console.log('Repair host:', JSON.parse(readFileSync(join(host, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version);
if (plugin) console.log('Repair plugin:', realpathSync(plugin));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const shared = specifier.startsWith('@deepseek-ai/') || /^(?:zod|react|react-dom)(?:\/|$)/u.test(specifier);
    const result = nextResolve(specifier, parentURL && shared ? { ...context, parentURL } : context);
    return candidate && result.url === development ? { ...result, url: candidate } : result;
  },
});
