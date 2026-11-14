// Shared report schema; preserve existing measurement and evaluation evidence fields.
export const PROTOCOL = 'dsh-recall-evaluation-v1';

export const LIMITS = Object.freeze({ requestsPerTrial: 8, trialMs: 180000 });

export function summary(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = `${trial.mode}/${trial.arm ?? trial.records}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(trial);
  }
  return [...groups].map(([group, rows]) => ({ group, n: rows.length, valid: rows.filter(r => r.grade?.valid).length,
    correct: rows.filter(r => r.grade?.correct === true).length, recallSupportedCorrect: rows.filter(r => r.grade?.recallSupportedCorrect).length,
    errors: rows.filter(r => r.failure || r.infrastructureFailure).length,
    modelRequests: rows.reduce((n, r) => n + (r.requests?.length ?? 0), 0), toolCalls: rows.reduce((n, r) => n + (r.tools?.length ?? 0), 0),
    elapsedMs: rows.map(r => r.resources?.elapsedMs ?? null) }));
}
