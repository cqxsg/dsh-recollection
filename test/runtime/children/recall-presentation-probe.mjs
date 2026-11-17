import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { currentInteraction } from '../../../lib/index.js';
import { verifyRecallPresentationProbe } from '../../client/recall-presentation-probe.mjs';

const mode = process.argv[3], output = join(process.env.DSH_HOME, '..');
const evidence = { mode, pid: process.pid, startedAt: new Date().toISOString(), cases: [], requests: [], submitted: [] };
const check = async (label, task) => { await task(); evidence.cases.push(label); console.log(`PASS: ${label}`); };
let runtime, h, off, unregister;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-presentation-probe'), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  const ctx = runtime.ctx;
  await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.await();
  off = ctx.on('llm/stream', async function* (options, next) {
    if (options.provider === 'recall-fixture') evidence.requests.push(structuredClone(options.messages));
    yield* next();
  });
  h = recallHarness(ctx); await h.ready();
  if (mode === 'reopen') {
    const before = JSON.parse(await readFile(join(output, 'probe-evidence.json'), 'utf8'));
    const handle = await ctx.agents.resume({ resumeSessionId: before.sessionId, agentOptions: h.model.options }); h.agents.push(handle);
    await check('fresh process restores full instruction, structured source, message ID and charged budget without replay', async () => {
      const messages = handle.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.dshRecollection);
      assert.deepEqual(messages, before.markedEvents);
      assert.deepEqual(currentInteraction(handle.agent.session), before.identity);
      assert.deepEqual(ctx.recallBudget.records().filter(r => r.sessionId === before.sessionId), before.budget);
      assert.equal(evidence.requests.length, 0);
    });
  } else {
    const { agent } = await h.seed('rc4a-presentation', ['needle historical proof']);
    evidence.sessionId = agent.id;
    unregister = ctx.commands.register({
      name: 'rc4a-probe', description: 'RC4A probe description', input: { hint: '[RC4A input]' },
      handler({ agent, rawInput }) {
        const message = createUserMessage({ source: { kind: 'user', dshRecollection: { type: 'recall', userInput: rawInput.trim() ? rawInput : '' } },
          content: [{ type: 'text', text: `RC4A_INTERNAL_INSTRUCTION\n${rawInput}` }] });
        evidence.submitted.push(structuredClone(message));
        agent.steer(message);
        return { kind: 'success' };
      },
    });
    await verifyRecallPresentationProbe({ ctx, agent, h, evidence, check, output });
    await ctx.sessions.flush(agent.session);
    evidence.markedEvents = agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.dshRecollection);
    evidence.identity = currentInteraction(agent.session);
    evidence.budget = ctx.recallBudget.records().filter(r => r.sessionId === agent.id);
    await check('one native user message per command retains source kind, model input and budget identity', async () => {
      assert.equal(evidence.markedEvents.length, evidence.submitted.length);
      for (const message of evidence.submitted) {
        const matches = evidence.markedEvents.filter(e => e.data.id === message.id);
        assert.equal(matches.length, 1); assert.deepEqual(matches[0].data.source, message.source);
        assert.deepEqual(matches[0].data.content, message.content);
        assert.ok(evidence.requests.some(messages => messages.some(m => m.id === message.id && m.content[0]?.text === message.content[0].text)));
      }
      assert.equal(evidence.identity.interactionId, evidence.openingId ?? evidence.submitted.at(-2).id, 'mid-turn steering shares the opening request identity');
      assert.equal(ctx.recallBudget.state(evidence.identity).shared, 11, 'one real search charged once');
    });
  }
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error.stack; console.error(error); process.exitCode = 1; }
finally {
  unregister?.(); off?.(); await h?.dispose();
  await runtime?.shutdown.shutdown(process.exitCode ?? 0);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(output, `${mode}-evidence.json`), JSON.stringify(evidence, null, 2));
}
