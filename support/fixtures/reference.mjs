export const referenceFixture = (sessionId = 'reference-store', seq = 1) => ({ sessionId, formatVersion: 4,
  historyId: 'a'.repeat(64), seq, recordId: 'b'.repeat(64), fingerprint: 'c'.repeat(64) });
