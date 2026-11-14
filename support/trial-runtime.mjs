import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { PROTOCOL } from './trial-report.mjs';
import { environment } from './environment.mjs';
import { checkpointWriter } from './checkpoint.mjs';

export async function runTrialRuntime(spec, execute, createResources) {
  const writeCheckpoint = checkpointWriter(`${spec.output}.checkpoint.json`), writeResult = checkpointWriter(spec.output);
  const machine = environment();
  let runtime, result, resources, watchedMatcher, restoreLaunch = () => {}, stage = 'booting', snapshot = () => ({ mode: spec.mode, arm: spec.arm, task: spec.task, records: spec.records });
  const bindMatcher = () => {
    const matcher = runtime?.ctx.get('recallTools')?.search.matcher;
    if (!resources || !matcher || matcher === watchedMatcher) return;
    restoreLaunch(); watchedMatcher = matcher;
    const launch = matcher.launch;
    if (typeof launch !== 'function') throw new Error('The selected matcher must expose an experiment process-launch hook.');
    matcher.launch = (...args) => { const child = launch(...args); resources.track(child.pid); return child; };
    restoreLaunch = () => { matcher.launch = launch; };
  };
  let termination, interrupt, heartbeatWrite;
  const interrupted = new Promise((_, reject) => { interrupt = reason => { termination ??= reason; reject(new Error(reason)); }; });
  const onMessage = message => { if (message?.type === 'experiment-stop') interrupt('parent_watchdog'); };
  process.on('message', onMessage);
  const persist = () => writeCheckpoint({ protocol: PROTOCOL, recordedAt: new Date().toISOString(), environment: machine,
    ...snapshot(), processResources: resources?.snapshot(), stage, trialComplete: false, checkpoint: true, termination });
  const progress = async (next, read) => {
    if (termination) throw new Error(termination);
    bindMatcher();
    stage = next; snapshot = read; resources?.phase(next); await persist();
  };
  const watchdog = setTimeout(() => interrupt('runtime_watchdog'), spec.trialWatchdogMs ?? (spec.mode === 'performance' ? 300000 : 210000));
  const heartbeat = spec.mode === 'performance' ? setInterval(() => {
    if (heartbeatWrite) return;
    heartbeatWrite = persist().catch(() => interrupt('checkpoint_write_failed')).finally(() => { heartbeatWrite = undefined; });
  }, 5000) : undefined;
  try {
    result = await Promise.race([interrupted, (async () => {
      await persist();
      runtime = await runProfile({ environment: loadLayeredEnv('recall-experiment', process.cwd()), profile: 'web',
        patchFiles: [spec.patchPath], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
      if (termination) { await runtime.shutdown.shutdown(2); throw new Error(termination); }
      const readyBy = performance.now() + 15000;
      while (!runtime.ctx.get('tools') || (spec.suite !== 'discussions' && !runtime.ctx.get('tools')?.get('read'))
        || (spec.arm !== 'D0' && !runtime.ctx.get('recallTools'))) {
        if (performance.now() > readyBy) throw new Error('experiment_services_not_ready');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (spec.resources) {
        resources = await createResources({ intervalMs: spec.resourceIntervalMs ?? 10 });
        bindMatcher();
      }
      return execute(runtime.ctx, spec, progress);
    })()]);
  } catch (error) {
    result = { ...snapshot(), infrastructureFailure: termination ?? String(error?.code ?? error?.message ?? 'experiment_failed') };
    console.error(spec.mode === 'model' ? result.infrastructureFailure : error.stack);
    process.exitCode = termination ? 2 : 1;
  } finally {
    clearTimeout(watchdog); clearInterval(heartbeat); process.removeListener('message', onMessage);
    await heartbeatWrite;
    // Save before shutdown; the parent retains this evidence even if shutdown stalls.
    const persistResult = () => writeResult({ protocol: PROTOCOL, recordedAt: new Date().toISOString(), environment: machine, ...result,
      processResources: resources?.snapshot(), stage, trialComplete: !result?.infrastructureFailure, termination });
    await persistResult();
    try { await runtime?.shutdown.shutdown(process.exitCode ?? 0); }
    finally {
      restoreLaunch();
      if (resources) {
        const measured = await resources.stop();
        if (!measured.complete) { result.infrastructureFailure ??= measured.failure ?? 'resource_capture_incomplete'; process.exitCode ||= 1; }
        await persistResult();
      }
      if (process.connected) process.disconnect();
    }
  }
}
