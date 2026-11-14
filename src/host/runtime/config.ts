import { z } from 'zod';

export const DEFAULT_CACHE_MIB = 512;
export const MAX_TIMER_MS = 2_147_483_647;
const timerMs = z.number().int().positive().max(MAX_TIMER_MS);

export const recallConfig = z.strictObject({
  cacheMiB: z.number().int().min(1).max(1024).default(DEFAULT_CACHE_MIB),
  previewTokens: z.number().int().positive().default(300), searchPageTokens: z.number().int().positive().default(2000),
  readPageTokens: z.number().int().positive().default(2000), spillRatio: z.number().positive().max(0.8).default(0.8),
  searches: z.number().int().nonnegative().default(6), shared: z.number().int().nonnegative().default(12),
  freePages: z.number().int().nonnegative().default(2), paidPages: z.number().int().nonnegative().default(2),
  contextBefore: z.number().int().nonnegative().default(2), contextAfter: z.number().int().nonnegative().default(2),
  prepareMs: timerMs.default(15000), businessMs: timerMs.default(55000),
  outerMs: timerMs.default(60000), workerPath: z.string().min(1).optional(), rgPath: z.string().optional(),
  hashAttempts: z.number().int().positive().default(2), hashActiveMs: z.number().int().positive().default(15000),
}).superRefine((c, ctx) => {
  if (c.rgPath !== undefined) ctx.addIssue({ code: 'custom', path: ['rgPath'], message: 'rgPath is obsolete: remove it to use the packaged worker, or set workerPath to the matching verified worker binary.' });
  if (c.prepareMs > c.businessMs || c.outerMs - c.businessMs < 5000) ctx.addIssue({ code: 'custom', message: 'prepareMs <= businessMs and at least 5000ms cleanup margin are required' });
});
export type RecallConfig = Readonly<z.infer<typeof recallConfig>>;
export const loadRecallConfig = (raw: unknown = {}): RecallConfig => Object.freeze(recallConfig.parse(raw));
