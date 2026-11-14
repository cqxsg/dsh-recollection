import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { waitForRecall } from '../../support/wait-for-recall.mjs';

// This process is launched only after homes, environment and cwd are isolated.
const validation = process.argv.includes('--smoke') ? await import('../../test/runners/web-scenarios.mjs') : undefined;
const options = validation?.readWebOptions(process.argv);
const timeout = validation ? setTimeout(() => {
  console.error('Web validation exceeded its time limit.');
  process.exit(1);
}, validation.webTimeout(options)) : undefined;
let runtime;
try {
  runtime = await runProfile({
    environment: loadLayeredEnv('recall-web', process.cwd()),
    profile: 'web',
    patchFiles: [process.argv[2]],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
  });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  if ([...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.config.enabled) await waitForRecall(runtime.ctx);
  if (validation) {
    await validation.verifyWebScenarios(runtime, options);
    await runtime.shutdown.shutdown(0);
    validation.verifyWebShutdown(runtime.ctx);
  }
} catch (error) {
  console.error(error);
  if (runtime) await runtime.shutdown.shutdown(1);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
