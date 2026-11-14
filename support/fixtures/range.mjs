/** Native committed operations with named sources; no model or attachment IO. */
export const text = value => ({ type: 'text', text: value });
export const image = name => ({ type: 'image', attachment: {
  attachmentId: `image-${name}`, name: `${name}.png`, mediaType: 'image/png', bytes: 12, width: 2, height: 2,
} });
export const file = { type: 'file', attachment: { attachmentId: 'a'.repeat(64), name: 'notes.txt', bytes: 8 } };

export function rangeFixture(session) {
  const append = (type, data, intent) => session.append(type, data, intent);
  const user = (content, source = { kind: 'user' }) => append('user/message', {
    id: `${session.id}-user-${session.seq}`, role: 'user', source, content,
  }, { surfaceOp: 'append' });
  const assistant = (content, turn = 1, step = 1) => append('assistant/message', {
    turn, step, stream: [], message: {
      id: `${session.id}-assistant-${session.seq}`, role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content,
    },
  }, { surfaceOp: 'append' });
  const callBlock = (id, name = 'read', args = '{"path":"notes.txt"}') => ({ type: 'tool-call', id, name, arguments: args });
  const callLog = (block, turn = 1, step = 1) => append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments });
  const result = (block, call, content = [text('saved tool output')], turn = 1, step = 1) => append('tool/result', {
    turn, step, message: {
      id: `${session.id}-result-${session.seq}`, role: 'tool', source: { kind: 'tool', callId: block.id },
      toolCallId: block.id, isError: false, content,
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  const summary = (nodes, extraSources = []) => {
    const compactionId = `${session.id}-compact-${session.seq}`;
    const start = append('compaction/start', { compactionId, turn: null });
    const pricing = append('compaction/summary', {
      compactionId, summary: [text('fixture summary')], provider: 'fixture', model: 'fixture',
      shadowedRange: { start: nodes[0], end: nodes.at(-1) }, shadowedSeqs: nodes, shadowedTokenCount: 100,
    });
    const replacement = append('user/message', {
      id: `${session.id}-summary-${session.seq}`, role: 'user', source: { kind: 'compact-checkpoint', compactionId },
      content: [text('fixture summary, not original discussion')],
    }, { surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) }, sourceEventSeqs: [start.seq, pricing.seq, ...nodes, ...extraSources] });
    append('compaction/end', { compactionId, turn: null });
    return replacement;
  };
  const prune = original => {
    append('compaction/prune', { shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq], shadowedTokenCount: 50 });
    return append('tool/result', { ...original.data, message: { ...original.data.message, content: [text('[pruned]')] } }, {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq],
    });
  };
  const offload = (event, imageIndexes) => append('image/offload', { targets: [{ seq: event.seq, imageIndexes }] });
  return { append, user, assistant, callBlock, callLog, result, summary, prune, offload };
}

export const sessionCut = session => ({
  source: 'live', header: session.header, cursor: session.seq - 1,
  inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents(),
});
