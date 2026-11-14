import { argumentsHash } from '../runtime/identity.js';
import type { SearchTerms } from '../protocol.js';
export function queryTermsId(terms: SearchTerms): string {
  // OR sets can be reordered/deduplicated without changing semantics. Whitespace and regex are preserved.
  return argumentsHash({ mode: terms.mode, patterns: [...new Set(terms.patterns)].sort(), case_sensitive: terms.mode === 'literal' && terms.case_sensitive,
    roles: [...new Set(terms.roles ?? ['user', 'assistant', 'tool'])].sort(), kinds: [...new Set(terms.kinds ?? ['message', 'tool_call', 'tool_result'])].sort() });
}
export const logicalQueryId = (terms: SearchTerms, rangeIdentity: unknown) => argumentsHash([queryTermsId(terms), rangeIdentity]);
