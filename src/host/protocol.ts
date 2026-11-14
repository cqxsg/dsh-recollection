import { z } from 'zod';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import { SEARCH_PARAMETERS, READ_PARAMETERS } from './tool-descriptions.js';

const string = z.string().min(1);
const search = z.strictObject({
  action: z.literal('search').describe(SEARCH_PARAMETERS.action),
  mode: z.enum(['literal', 'regex']).describe(SEARCH_PARAMETERS.mode),
  patterns: z.array(string).min(1).describe(SEARCH_PARAMETERS.patterns),
  case_sensitive: z.boolean().default(false).describe(SEARCH_PARAMETERS.case_sensitive),
  roles: z.array(z.enum(['user', 'assistant', 'tool'])).min(1).optional().describe(SEARCH_PARAMETERS.roles),
  kinds: z.array(z.enum(['message', 'tool_call', 'tool_result'])).min(1).optional().describe(SEARCH_PARAMETERS.kinds),
  order: z.enum(['newest', 'oldest']).default('newest').describe(SEARCH_PARAMETERS.order),
});
const searchNext = z.strictObject({ action: z.literal('next').describe(SEARCH_PARAMETERS.action), cursor: string.describe(SEARCH_PARAMETERS.cursor) });
const readNext = z.strictObject({ action: z.literal('next').describe(READ_PARAMETERS.action), cursor: string.describe(READ_PARAMETERS.cursor) });
const readAction = z.literal('read').describe(READ_PARAMETERS.action);
const readRef = string.describe(READ_PARAMETERS.ref);
const readScope = z.enum(['record', 'context', 'turn']).default('record').describe(READ_PARAMETERS.scope);
const readAttachments = z.array(string).min(1).describe(READ_PARAMETERS.attachments);
export const searchInput = z.discriminatedUnion('action', [search, searchNext]);
export const readInput = z.union([
  z.strictObject({ action: readAction, ref: readRef, target: z.literal('text').default('text').describe(READ_PARAMETERS.target), scope: readScope }),
  z.strictObject({ action: readAction, ref: readRef, target: z.literal('attachments').describe(READ_PARAMETERS.target), attachments: readAttachments }),
  z.strictObject({ action: readAction, ref: readRef, target: z.literal('both').describe(READ_PARAMETERS.target), scope: readScope, attachments: readAttachments }), readNext,
]);
export type SearchRequest = z.infer<typeof searchInput>;
export type SearchTerms = Extract<SearchRequest, { action: 'search' }>;
export type ReadRequest = z.infer<typeof readInput>;

export class RecallError extends HarnessError {
  constructor(code: string, message: string, readonly invalid = false, readonly recovery?: string, readonly invalidIdentity?: string) { super(message, code); this.name = 'RecallError'; }
}
export function parseRequest(tool: 'search' | 'read', raw: unknown): SearchRequest | ReadRequest {
  // Select the intended read branch before reporting issues. A top-level
  // union error would collapse unrelated ref/scope/attachment mistakes.
  const value = raw as { action?: unknown; target?: unknown } | null;
  const schema = tool === 'search' ? searchInput : value?.action === 'next' ? readNext : value?.action === 'read'
    ? readInput.options[value.target === 'attachments' ? 1 : value.target === 'both' ? 2 : 0]!
    : readInput;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new RecallError('invalid_arguments', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), true,
    (raw as { action?: unknown })?.action === 'next' ? 'next accepts only action and cursor.' : undefined,
    JSON.stringify(parsed.error.issues.map(i => [i.path, i.code, i.code === 'unrecognized_keys' ? [...i.keys].sort() : null]).sort()));
  return parsed.data;
}

const natural = z.number().int().nonnegative();
export const budgetSummary = z.strictObject({
  revision: natural, search_remaining: natural, shared_remaining: natural, query_pages_remaining: natural,
  paid_pages_remaining: natural, actual_calls: natural, closed: z.boolean(),
});
const source = z.strictObject({
  seq: natural, blocks: z.array(natural), role: z.enum(['user', 'assistant', 'tool']), kind: z.enum(['message', 'tool_call', 'tool_result']),
  time: z.number(), turn: natural.nullable(), step: natural.nullable(), inherited: z.boolean(),
  authorship: z.enum(['human', 'model', 'tool', 'injected']), messageId: z.string(),
  callId: z.string().optional(), tool: z.string().optional(),
});
export const attachmentItem = z.strictObject({ ref: string, block: natural, type: z.enum(['image', 'file', 'path', 'spill']), metadata: z.record(z.string(), z.json()), state: z.literal('not_checked') });
export type AttachmentItem = z.infer<typeof attachmentItem>;
export const attachmentResult = z.strictObject({
  ref: string, sourceRef: string, block: natural, type: z.enum(['image', 'file', 'path', 'spill']),
  state: z.enum(['accessible', 'missing', 'permission_denied', 'unreachable', 'unresolved', 'not_file', 'error']),
  path: string.optional(), reason: string.optional(), contentRead: z.literal(false), checkedAt: natural,
  storage: z.enum(['archived_file', 'normalized_image', 'current_file', 'spill']),
  version: z.strictObject({ state: z.enum(['same', 'different', 'unverified', 'native_identity']), reason: string.optional(),
    baselineAt: natural.optional(), checkedAt: natural.optional(), algorithm: z.literal('sha256').optional(), hash: string.optional() }),
}).superRefine((r, ctx) => {
  if ((r.state === 'accessible') !== !!r.path) ctx.addIssue({ code: 'custom', message: 'Only accessible files have a verified execution path' });
});
export type AttachmentResult = z.infer<typeof attachmentResult>;
export const resultItem = z.strictObject({
  ref: string, source, content: z.string(), contentComplete: z.boolean(),
  start: natural, end: natural, omittedBefore: z.boolean(), omittedAfter: z.boolean(),
  undisplayedMatches: natural.optional(), attachments: z.array(attachmentItem),
  matchedIn: z.array(z.enum(['body', 'metadata'])).optional(),
});
export const recallResult = z.strictObject({
  status: z.enum(['ok', 'incomplete', 'error']), code: z.string().optional(), message: z.string().optional(), recovery: z.string().optional(),
  scanComplete: z.boolean().optional(), readComplete: z.boolean().optional(), sourceComplete: z.boolean().optional(),
  scannedRecords: natural.optional(), totalHits: natural.optional(),
  start: natural.optional(), end: natural.optional(), remaining: natural.optional(),
  range: z.string().optional(), gaps: z.array(z.string()).optional(), boundaries: z.array(z.string()).optional(),
  attachmentResults: z.array(attachmentResult).optional(), attachmentsComplete: z.boolean().optional(), textRequested: z.boolean().optional(),
  attachmentStart: natural.optional(), attachmentEnd: natural.optional(), attachmentsRemaining: natural.optional(),
  items: z.array(resultItem), nextCursor: z.string().optional(), budget: budgetSummary, allowed_actions: z.array(z.string()),
});
export type RecallResult = z.infer<typeof recallResult>;
export type ResultItem = z.infer<typeof resultItem>;
export type BudgetSummary = z.infer<typeof budgetSummary>;

/** Native rc.4's supported schema subset. Zod additionally enforces lengths/refinements. */
export function nativeSchema(schema: z.ZodType): JsonSchemaNode {
  const raw = z.toJSONSchema(schema, { io: 'input' });
  const walk = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    const out: any = {};
    for (const [key, value] of Object.entries(node)) {
      if (['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'default'].includes(key)) {
        if (key === 'properties') out[key] = Object.fromEntries(Object.entries(value as object).map(([name, child]) => [name, walk(child)]));
        else if (key === 'additionalProperties' && typeof value !== 'boolean') out[key] = true;
        else out[key] = walk(value);
      } else if (key === 'anyOf') out.oneOf = walk(value);
    }
    // Free JSON metadata has overlapping anyOf arms; annotation-only is the native unconstrained JSON node.
    if (node.$ref || node.anyOf?.some((arm: any) => arm.$ref)) return {};
    return out;
  };
  return walk(raw);
}

/** Describe an object root to Native; action-specific exclusion is enforced by parseRequest. */
export function inputSchema(tool: 'search' | 'read'): JsonSchemaNode {
  const alternatives = tool === 'search' ? [search, searchNext] : readInput.options;
  const properties: Record<string, JsonSchemaNode> = {};
  for (const alternative of alternatives) {
    const node = nativeSchema(alternative) as { properties: Record<string, JsonSchemaNode> };
    for (const [key, value] of Object.entries(node.properties)) if (key !== 'action' && key !== 'target') properties[key] = value;
  }
  properties.action = { type: 'string', enum: tool === 'search' ? ['search', 'next'] : ['read', 'next'], description: (tool === 'search' ? SEARCH_PARAMETERS : READ_PARAMETERS).action };
  if (tool === 'read') properties.target = { type: 'string', enum: ['text', 'attachments', 'both'], default: 'text', description: READ_PARAMETERS.target };
  return { type: 'object', additionalProperties: false, properties, required: ['action'] };
}
