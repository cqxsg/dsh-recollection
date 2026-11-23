import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';

/** Seed a native persisted history before an agent resumes it. Detached Sessions
 * avoid relying on an unannounced store membership (forbidden by newer hosts). */
export async function repairHistoryFixture(ctx, id) {
  const header = ctx.sessions.prepare(id, { meta: { cwd: process.cwd(), delegationDepth: 0 } }).header;
  const session = Session.create(id, [], header, 0);
  const writer = await ctx.sessionPersistence.create(header, { inheritedEventCount: 0 });
  let saved = 0;
  return {
    session,
    async flush() {
      const events = session.snapshotEvents();
      await writer.append(events.slice(saved)); await writer.flush(); saved = events.length;
    },
    async close() { await writer.close(); assert.ok(await ctx.sessionPersistence.stat(id)); },
  };
}
