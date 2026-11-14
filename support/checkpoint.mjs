import { readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

async function replaceCheckpoint(temporary, path) {
  // Windows readers/antivirus can briefly deny delete sharing. Keep the old
  // complete checkpoint visible; never unlink it to make replacement succeed.
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, path); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await delay(50);
    }
  }
}

/** Serialize writes and rename only complete JSON. A crash keeps the previous checkpoint. */
export function checkpointWriter(path) {
  let tail = Promise.resolve();
  return value => {
    const json = JSON.stringify(value, null, 2);
    tail = tail.then(async () => { await writeFile(`${path}.tmp`, json); await replaceCheckpoint(`${path}.tmp`, path); });
    return tail;
  };
}

export async function recoverTrial(output, job, code, termination) {
  let result;
  try { result = JSON.parse(await readFile(output, 'utf8')); }
  catch {
    try { result = { ...JSON.parse(await readFile(`${output}.checkpoint.json`, 'utf8')), recoveredCheckpoint: true }; }
    catch { result = { ...job, checkpointUnavailable: true }; }
    result.trialComplete = false;
    result.infrastructureFailure = termination ?? `child_exit_${code}_without_final_result`;
  }
  if (code !== 0 || termination) {
    result.trialComplete = false;
    result.infrastructureFailure ??= termination ?? `child_exit_${code}`;
  }
  return result;
}
