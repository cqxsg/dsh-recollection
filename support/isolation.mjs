import { projectRoot } from './paths.mjs';
import { mkdir, mkdtemp, access } from 'node:fs/promises';
import { join, delimiter } from 'node:path';

/** Isolate homes and cwd before importing any DSH runtime or loading dotenv. */
export async function isolatedEnvironment(label, { persistent = false } = {}) {
  const parent = join(projectRoot, '.local', label);
  await mkdir(parent, { recursive: true });
  const root = persistent ? parent : await mkdtemp(join(parent, 'run-'));
  const home = join(root, 'dsh-home');
  const agents = join(root, 'agents-home');
  const cwd = join(root, 'workspace');
  await Promise.all([home, agents, cwd].map(path => mkdir(path, { recursive: true })));
  // Do not inherit API keys, proxies, NODE_OPTIONS, or a user's DSH overrides.
  const env = {};
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'lang', 'lc_all']);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase())) env[key] = value;
  }
  const verifiedRg = join(projectRoot, '.local', 'tools', 'ripgrep-15.2.0-x86_64-pc-windows-msvc');
  if (process.platform === 'win32') {
    try {
      await access(join(verifiedRg, 'rg.exe'));
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      env[pathKey] = verifiedRg + delimiter + (env[pathKey] ?? '');
    } catch { /* Runtime reports an explicit missing/version error for a caller-provided rg. */ }
  }
  Object.assign(env, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: agents,
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
  });
  return { root, home, agents, cwd, env };
}
