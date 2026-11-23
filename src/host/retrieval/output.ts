import type { Context } from '@deepseek-ai/cordis';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { RecallError, recallResult, type RecallResult } from '../protocol.js';
import type { RecallConfig } from '../runtime/config.js';
import { policyFibers, policyActive } from '../runtime/policies.js';
import { completionEnvelope } from '../runtime/guidance.js';

export type SpillBudget = { state: 'enabled'; tokens: number } | { state: 'disabled' } | { state: 'unknown'; reason: string };
/** Read all applicable mounted native spill policies. Never infer from a config file. */
export function effectiveSpill(ctx: Context, exec?: ToolExecution): SpillBudget {
  try {
    const applicable = policyFibers(ctx, 'spill-policy', exec);
    if (applicable.some(f => !policyActive(f))) return { state: 'unknown', reason: 'Spill policy is transitioning or failed' };
    if (applicable.some(f => !f.runtime?.Config || !f.config || typeof f.config !== 'object'
      || (!Object.hasOwn(f.config, 'maxInlineTokens') && Object.keys(f.config).length > 0))) {
      return { state: 'unknown', reason: 'Mounted spill policy does not expose the validated native configuration contract' };
    }
    const caps = applicable.map(f => f.config?.maxInlineTokens).filter(h => h !== undefined);
    if (caps.some(h => !Number.isSafeInteger(h) || h < 0)) return { state: 'unknown', reason: 'Invalid effective spill cap' };
    return caps.length ? { state: 'enabled', tokens: Math.min(...caps) } : { state: 'disabled' };
  } catch { return { state: 'unknown', reason: 'Effective native policy could not be inspected' }; }
}
export function pageBudget(config: RecallConfig, tool: 'search' | 'read', spill: SpillBudget): number {
  if (spill.state === 'unknown') throw new RecallError('configuration_unknown', spill.reason);
  const component = tool === 'search' ? config.searchPageTokens : config.readPageTokens;
  return spill.state === 'enabled' ? Math.min(component, Math.floor(config.spillRatio * spill.tokens)) : component;
}
export const renderRecall = (value: RecallResult) => [{ type: 'text' as const, text: JSON.stringify(value) }];
export const renderedTokens = (value: RecallResult) => estimateContent(renderRecall(value));
export const pageTokens = (value: RecallResult) => renderedTokens(completionEnvelope(value));
export function verifyPageOutput(value: RecallResult, budget: number): RecallResult {
  verifyOutput(value, budget);
  if (pageTokens(value) > budget) throw new RecallError('output_budget_too_small', 'The page and its final completion metadata do not fit the effective page budget.');
  return value;
}
export const textTokens = (text: string) => estimateContent([{ type: 'text', text }]);
export function verifyOutput(value: RecallResult, budget: number): RecallResult {
  recallResult.parse(value);
  if (renderedTokens(value) > budget) throw new RecallError('output_budget_too_small', 'The complete result, including required sources and continuation data, does not fit the effective page budget.');
  return value;
}
export function unicodeBoundary(text: string, at: number): number {
  if (at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!)) return at - 1;
  return at;
}
