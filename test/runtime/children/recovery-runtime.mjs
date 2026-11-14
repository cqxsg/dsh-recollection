import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { verifyLedger, crashLedger, recoverLedger } from '../../state/ledger-native.mjs';

const timeout = setTimeout(() => { console.error('Recovery validation exceeded 120 seconds'); process.exit(1); }, 120_000);
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const [mode, phase] = process.argv[3].split(':');
  if (mode === 'verify') await verifyLedger(runtime.ctx);
  else if (mode === 'crash') await crashLedger(runtime.ctx, phase);
  else await recoverLedger(runtime.ctx, phase);
  await runtime.shutdown.shutdown(0);
} catch (error) {
  console.error(error);
  if (runtime) await runtime.shutdown.shutdown(1);
  process.exitCode = 1;
} finally { clearTimeout(timeout); }
