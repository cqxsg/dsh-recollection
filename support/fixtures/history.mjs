import assert from 'node:assert/strict';
import { buildForkSeed } from '@deepseek-ai/dsh-session';

/** Build balanced, known native events without an agent loop or a model request. */
export function appendTurn(session, turn, text) {
  session.append('turn/start', { turn });
  session.append('user/message', {
    id: `${session.id}-message-${turn}`, role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

/** Native prepare/enter and persistence handles, without Web creation enrichers. */
export async function createHistoryFixture(ctx, id, texts, parent) {
  let session;
  const fiber = ctx.plugin({
    name: `fixture-${id}`,
    inject: ['sessions'],
    apply(scope) {
      session = scope.sessions.prepare(id, parent ? {
        seed: buildForkSeed(parent.snapshotEvents(), parent.seq - 1),
        inheritedEventCount: parent.seq,
        meta: { cwd: process.cwd(), parentSession: parent.id, isSeeded: true, delegationDepth: 0 },
      } : { meta: { cwd: process.cwd(), delegationDepth: 0 } });
      const firstTurn = (parent?.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 0) + 1;
      texts.forEach((text, index) => appendTurn(session, index + firstTurn, text));
      scope.effect(() => scope.sessions.enter(session));
    },
  });
  await fiber.await();
  assert.ok(session, 'native fixture attached');
  const writer = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount });
  await writer.append(session.snapshotEvents());
  await writer.flush();
  // Once entered, the backend routes later session/event appends to this handle.
  const flush = async () => assert.equal(await ctx.sessions.flush(session), true);
  return {
    session, flush,
    async close(validate = true) {
      await writer.close();
      await fiber.dispose();
      if (validate) {
        assert.equal(ctx.sessions.get(id), undefined, 'fixture detached before cold read');
        assert.ok(await ctx.sessionPersistence.stat(id), 'fixture durably stored');
      }
    },
  };
}
