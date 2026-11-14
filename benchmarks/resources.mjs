import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export async function processResourceMeter({ python = 'python', intervalMs = 10, maxRecords = 100000, maxActive = 128 } = {}) {
  if (process.platform !== 'win32') throw new Error('The frozen resource sampler supports Windows only.');
  const child = spawn(python, ['-u', fileURLToPath(new URL('./windows-resources.py', import.meta.url)), '--host', String(process.pid),
    '--interval-ms', String(intervalMs), '--max-active', String(maxActive)], { windowsHide: true, stdio: 'pipe' });
  const ready = Promise.withResolvers(), closed = Promise.withResolvers(), rows = [], owners = new Map();
  let failure, stderr = '', serial = 0, phase = 'startup', latest, final, droppedFrames = 0, droppedRecords = 0, stopped;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.type === 'ready' && value.version === 1) ready.resolve(value);
      else if (value.type === 'process') {
        if (value.kind !== 'matcher') owners.set(value.kind, value);
        else if (rows.length < maxRecords) rows.push(value); else droppedRecords++;
      }
      else if (value.type === 'progress') latest = value;
      else if (value.type === 'final') final = value;
      else failure ??= 'invalid_sampler_frame';
    } catch { failure ??= 'invalid_sampler_json'; }
  });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(0, 4000); });
  child.stdin.on('error', () => { failure ??= 'sampler_pipe_failed'; });
  child.on('error', error => { failure = error.code ?? 'sampler_failed'; ready.reject(error); });
  child.on('close', code => { if (code !== 0) failure ??= `sampler_exit_${code}`; ready.reject(new Error(failure ?? 'sampler_closed_before_ready')); closed.resolve(code); });
  const startup = setTimeout(() => { failure = 'sampler_startup_timeout'; child.kill(); ready.reject(new Error(failure)); }, 10000);
  let environment;
  try { environment = await ready.promise; } finally { clearTimeout(startup); }
  const send = value => {
    if (failure || child.stdin.destroyed || child.stdin.writableLength > 65536) { droppedFrames++; return; }
    child.stdin.write(JSON.stringify(value) + '\n');
  };
  const snapshot = () => ({ protocol: 'dsh-process-resources-v1', enabled: true, complete: !!final && !failure && !droppedFrames,
    intervalMs, maxRecords, environment, droppedFrames, droppedRecords, registeredByHost: serial, failure, stderr: stderr || undefined,
    elapsedMs: final?.elapsedMs, ...(final ?? latest ?? {}), processes: [...owners.values(), ...rows],
    definition: 'Host plus registered matcher processes in the same sampling sweep; sampled lower bound, not an atomic OS snapshot. Observer excluded and reported separately.' });
  return {
    track(pid) { const id = ++serial; if (pid) send({ type: 'add', id, pid, phase }); else droppedFrames++; },
    phase(label) { phase = label; send({ type: 'phase', phase }); },
    snapshot,
    async stop() {
      if (!stopped) stopped = (async () => {
        child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
        const timeout = setTimeout(() => { failure ??= 'sampler_stop_timeout'; child.kill(); }, 10000);
        try { await closed.promise; } finally { clearTimeout(timeout); lines.close(); }
        return snapshot();
      })();
      return stopped;
    },
  };
}
