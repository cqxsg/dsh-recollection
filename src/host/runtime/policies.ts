import { Context, type Fiber } from '@deepseek-ai/cordis';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';

// Cordis' public FiberState.ACTIVE value (a declaration-only const enum).
const ACTIVE = 2;

/** Inspect the mounted host contract, never a plugin imported by this bundle.
 * The names denote the native policy contracts, not arbitrary replacement code.
 * Scope filtering must match the carrier used by the tool execution service.
 */
export function policyFibers(ctx: Context, name: string, exec?: ToolExecution): Fiber[] {
  const carrier = scopeTarget(ctx.tools, exec?.agent);
  const filter = (carrier as unknown as { [Context.filter]: (ctx: Context) => boolean })[Context.filter];
  return [...ctx.registry.values()].filter(runtime => runtime.name === name)
    .flatMap(runtime => [...runtime.fibers])
    .filter(fiber => filter.call(carrier, fiber.ctx));
}

export const policyActive = (fiber: Fiber): boolean => fiber.state === ACTIVE;
