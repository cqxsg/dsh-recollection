import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

/** Controls only the isolated experiment, never the product's 15/55/60 second timeline. */
export async function runTrialProcess({ args, cwd, env, logPath, watchdogMs, graceMs = 30000 }) {
  const log = createWriteStream(logPath);
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let termination, failure, force;
  const forceTree = (reason = 'parent_watchdog_forced_tree') => {
    if (!child.pid) return;
    termination = reason;
    if (process.platform === 'win32') {
      const kill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      kill.on('error', error => { failure = error.code; child.kill(); });
    } else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure = error.code; } }
  };
  const logDone = finished(log).catch(error => { failure = error.code; forceTree('log_write_failed'); });
  const timeout = setTimeout(() => {
    termination = 'parent_watchdog';
    if (child.connected) child.send({ type: 'experiment-stop' }, () => {});
    force = setTimeout(forceTree, graceMs);
  }, watchdogMs);
  child.on('error', error => { failure = error.code; });
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timeout); clearTimeout(force); log.end(); await logDone;
  return { code, termination: termination ?? (failure ? `child_error_${failure}` : undefined) };
}
