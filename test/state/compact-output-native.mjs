import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { currentInteraction, recallResult } from '../../lib/index.js';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';

const compact = value => {
  assert.equal(Object.hasOwn(value, 'query'), false); assert.equal(Object.hasOwn(value, 'snapshot'), false);
  recallResult.parse(value);
};
export async function verifyCompactOutput(ctx) {
  const cases = [], observed = new Set(), ptcObserved = new Set();
  const check = async (label, run) => { await run(); cases.push(label); console.log(`PASS: ${label}`); };
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  const off = ctx.on('llm/stream', async function* (options, next) {
    if (options.provider === 'recall-fixture') for (const message of options.messages ?? []) {
      if (message.role !== 'tool') continue;
      for (const block of message.content ?? []) if (block.type === 'text') {
        if (message.toolCallId?.startsWith('compact-ptc')) {
          assert.doesNotMatch(block.text, /"(?:query|snapshot)"\s*:/);
          assert.match(block.text, /needle original evidence/); ptcObserved.add(message.toolCallId);
        }
        let value; try { value = JSON.parse(block.text); } catch { continue; }
        if (value?.status && Array.isArray(value.items)) { compact(value); observed.add(message.toolCallId); }
      }
    }
    yield* next();
  });
  // Observe before the scripted provider consumes the waterfall without calling next().
  const h = recallHarness(ctx);
  try {
    await check('native results, presentation metadata and the next model request omit identities without altering original text', async () => {
      const original = 'needle original {"query":"user value","snapshot":"user version"}', { agent } = await h.seed('compact-native', [original]);
      const found = await h.search(agent); compact(found.value);
      assert.equal(Object.hasOwn(found.data.meta.recall, 'query'), false); assert.equal(Object.hasOwn(found.data.meta.recall, 'snapshot'), false);
      assert.ok(observed.has(found.data.message.toolCallId));
      const read = await h.read(agent, found.value.items[0].ref); compact(read.value);
      assert.equal(read.value.items[0].content, original); assert.ok(observed.has(read.data.message.toolCallId));
      assert.equal(recallResult.safeParse({ ...found.value, query: 'hidden' }).success, false);
      assert.equal(recallResult.safeParse({ ...read.value, snapshot: 'hidden' }).success, false);
      const query = ctx.recallTools.search.queries.get(state(agent).queries[0].id);
      assert.match(query.id, /^[a-f0-9]{64}$/); assert.match(query.fingerprint, /^[a-f0-9]{64}$/);
    });
    await check('two searches interleave by cursor and distinct duplicate errors retain their internal identities', async () => {
      const { agent } = await h.seed('compact-interleaved', ['alpha', 'beta'].flatMap(word => Array.from({ length: 12 }, (_, i) => `${word} ${i} ` + 'body '.repeat(250))));
      const run = async (word, input = recovery()) => (await h.drive(agent, [{ name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: [word], order: 'oldest' } }], input))[0];
      const a = (await run('alpha', human('find both topics'))).value, aId = state(agent).calls.at(-1).query;
      const b = (await run('beta')).value, bId = state(agent).calls.at(-1).query;
      assert.notEqual(aId, bId); assert.ok(a.nextCursor && b.nextCursor);
      for (const [first, word, id] of [[a, 'alpha', aId], [b, 'beta', bId]]) {
        const page = (await h.next(agent, first.nextCursor)).value; compact(page);
        assert.equal(page.status, 'ok'); assert.equal(page.start, first.end); assert.ok(page.items.every(i => i.content.startsWith(word)));
        assert.equal(state(agent).calls.at(-1).query, id); assert.equal(page.budget.query_pages_remaining, 1);
      }
      const errors = [];
      for (const word of ['alpha', 'beta', 'beta']) {
        const value = (await run(word)).value; compact(value); assert.equal(value.code, 'duplicate_query');
        assert.doesNotMatch(value.message + value.recovery, /[a-f0-9]{64}/); errors.push(state(agent).calls.at(-1).invalidKey);
        if (errors.length < 3) assert.equal(value.budget.closed, false); else assert.equal(value.budget.closed, true);
      }
      assert.notEqual(errors[0], errors[1]); assert.equal(errors[1], errors[2]);
      assert.ok(errors[0].includes(aId) && errors[1].includes(bId));
    });
    await check('real PTC dispatch and following model request use the same compact result contract', async () => {
      const { agent } = await h.seed('compact-ptc-session', ['needle original evidence']);
      setSandboxMode(agent.session, 'read-only'); const dispose = agent.ctx.tools.presentAs('ptc');
      try {
        const [result] = await h.drive(agent, [{ id: 'compact-ptc-search', name: 'run_code', args: {
          code: 'return await tools.recall_search({action:"search",mode:"literal",patterns:["needle"]});', description: 'Find original evidence',
        } }], human('recall through PTC'));
        assert.equal(result.data.message.isError, false);
        const dispatch = agent.session.snapshotEvents().findLast(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'recall_search');
        const value = JSON.parse(dispatch.data.content[0].text); compact(value); assert.equal(value.status, 'ok');
        assert.ok(ptcObserved.has('compact-ptc-search'), 'PTC result reaches the next actual model request');
        assert.match(state(agent).calls.at(-1).query, /^[a-f0-9]{64}$/);
      } finally { dispose(); }
    });
  } finally { await off(); await h.dispose(); }
  const path = join(process.env.DSH_HOME, '..', 'compact-output-evidence.json');
  await writeFile(path, JSON.stringify({ cases, nativeCallsObserved: [...observed], ptcCallsObserved: [...ptcObserved] }, null, 2));
  console.log(`Compact output evidence: ${path}`);
}
