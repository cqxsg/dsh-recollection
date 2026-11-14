import { createHash } from 'node:crypto';

export const CORPUS_VERSION = 'dsh-performance-corpus-v1';
export const CORPUS_SEED = 0x5eedc0de;
export const SCALES = [128, 512, 2048, 5000, 10000];
const sha = text => createHash('sha256').update(text).digest('hex');
const markers = { none: 'Absent', sparse: 'Sparse', all: 'All' };
export const LEGACY_QUERIES = [
  { id: 'legacy-cold', mode: 'literal', patterns: ['benchmark-hit'], rate: 'cold', case_sensitive: false },
  { id: 'legacy-hot', mode: 'literal', patterns: ['needle'], rate: 'cold', case_sensitive: false },
];
export const QUERIES = Object.entries(markers).flatMap(([rate, tag]) => [
  { id: `literal-${rate}`, family: 'literal-word', rate, mode: 'literal', patterns: [`Dsh${tag}Alpha`], case_sensitive: true, primary: true },
  { id: `or-${rate}`, family: 'literal-or', rate, mode: 'literal', patterns: [`Dsh${tag}Alpha`, `通用${tag}甲标`], case_sensitive: true },
  { id: `unicode-${rate}`, family: 'unicode-case', rate, mode: 'literal', patterns: [`DSH${tag.toUpperCase()}ALPHA`, `通用${tag}甲标`], case_sensitive: false },
  { id: `anchor-${rate}`, family: 'regex-anchor', rate, mode: 'regex', patterns: [`(?m)^ANCHOR_${tag.toUpperCase()}_\\d+$`], case_sensitive: true },
  { id: `multiline-${rate}`, family: 'regex-multiline', rate, mode: 'regex', patterns: [`ANCHOR_${tag.toUpperCase()}_\\d+\\nTAIL_${tag.toUpperCase()}_\\d+`], case_sensitive: true, primary: true },
]);
export const BOUNDARY_QUERIES = [
  { id: 'metadata-all', mode: 'literal', patterns: ['META_SCOPE_ALL'], rate: 'metadata-all', case_sensitive: true },
  { id: 'metadata-sparse', mode: 'literal', patterns: ['META_SCOPE_SPARSE'], rate: 'metadata-sparse', case_sensitive: true },
  { id: 'metadata-none', mode: 'literal', patterns: ['META_SCOPE_ABSENT'], rate: 'none', case_sensitive: true },
  { id: 'cross-field', mode: 'regex', patterns: ['LEFT_EDGE[\\s\\S]*RIGHT_EDGE'], rate: 'none', case_sensitive: true },
  { id: 'cross-record', mode: 'regex', patterns: ['END_RECORD[\\s\\S]*START_RECORD'], rate: 'none', case_sensitive: true },
];
export const STRESS_MANIFEST = [
  ...[1, 8, 32].map(mib => ({ id: `long-${mib}mib`, bytes: mib * 1024 * 1024, pattern: 'LEFT[\\s\\S]*RIGHT', expectedSpans: 1 })),
  { id: 'dense-million', bytes: 2 * 1000000, pattern: 'x', expectedSpans: 1000000 },
  { id: 'zero-width', bytes: 4096, pattern: '(?m)^', pressure: 'zero-width' },
  { id: 'repeated-pattern', patterns: ['needle', 'needle'], pressure: 'OR identity' },
  { id: 'invalid', patterns: ['valid', '['], expectedError: 'invalid_pattern' },
  { id: 'unsupported', patterns: ['(?<=a)b'], expectedError: 'invalid_pattern' },
];

export function queryArgs(query) {
  return { action: 'search', mode: query.mode, patterns: query.patterns, case_sensitive: query.case_sensitive };
}
export function expectedIndexes(query, records) {
  return Array.from({ length: records }, (_, i) => i).filter(i => query.rate === 'all' || query.rate === 'sparse' && i % 100 === 0
    || query.rate === 'metadata-all' && i % 10 === 0 || query.rate === 'metadata-sparse' && i % 100 === 0
    || query.rate === 'cold' && i === Math.floor(records / 2));
}

/** No engine is used for the oracle: membership follows fixed marker placement. */
export function makeCorpus(profile, count, seed = CORPUS_SEED) {
  if (!['legacy', 'mixed'].includes(profile) || !Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('Invalid corpus selection');
  let random = seed >>> 0;
  const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
  const hash = createHash('sha256');
  let logicalBytes = 0, metadataBytes = 0;
  const records = Array.from({ length: count }, (_, i) => {
    let body, attachment;
    if (profile === 'legacy') body = `${i}: ${i === Math.floor(count / 2) ? 'benchmark-hit needle' : 'background-entry'} ` + 'stable history payload '.repeat(90);
    else {
      const head = `START_RECORD ${i}\nDshAllAlpha 通用All甲标\nANCHOR_ALL_42\nTAIL_ALL_42\n`
        + (i % 100 === 0 ? 'DshSparseAlpha 通用Sparse甲标\nANCHOR_SPARSE_42\nTAIL_SPARSE_42\n' : '')
        + (i === Math.floor(count / 2) ? 'ColdSeedToken\n' : '')
        + ['日志：设备运行正常，温度 42.7 ℃，状态 😀\n', 'export function transform(input) { return input.map(x => x + 7); }\n', '{"tool":"build","exitCode":0,"stdout":"已完成编译","durationMs":127}\n'][i % 3];
      const target = [512, 1024, 2048, 2048, 2560, 4096][i % 6], tail = '\nEND_RECORD';
      const remaining = Math.max(0, target - Buffer.byteLength(head + tail));
      let payload = ''; while (payload.length < remaining) payload += next().toString(16).padStart(8, '0');
      body = head + payload.slice(0, remaining) + tail;
      if (i % 10 === 0) attachment = { attachmentId: sha(`synthetic-metadata-${i}`),
        name: `META_SCOPE_ALL ${i % 100 === 0 ? 'META_SCOPE_SPARSE ' : ''}LEFT_EDGE ${i}.txt`,
        mediaType: 'application/x-RIGHT_EDGE', bytes: 12 };
    }
    const split = profile === 'mixed' ? body.indexOf('ANCHOR_ALL') + 5 : body.length;
    const parts = split < body.length ? [body.slice(0, split), body.slice(split)] : [body];
    const row = { index: i, parts, ...(attachment ? { attachment } : {}) };
    const serialized = JSON.stringify(row);
    hash.update(`${Buffer.byteLength(serialized)}:`).update(serialized);
    logicalBytes += Buffer.byteLength(body); metadataBytes += attachment ? Buffer.byteLength(JSON.stringify(attachment)) : 0;
    return row;
  });
  return { version: CORPUS_VERSION, profile, seed, count, logicalBytes, metadataBytes,
    meanBodyBytes: logicalBytes / count, sourceDigest: hash.digest('hex'), records };
}

export function corpusManifest() {
  return { version: CORPUS_VERSION, seed: CORPUS_SEED, scales: SCALES, queries: QUERIES, legacyQueries: LEGACY_QUERIES, boundaryQueries: BOUNDARY_QUERIES, stress: STRESS_MANIFEST,
    data: ['legacy', 'mixed'].flatMap(profile => SCALES.map(count => {
      const { records, ...metadata } = makeCorpus(profile, count);
      return { ...metadata, expectedHits: Object.fromEntries((profile === 'legacy' ? LEGACY_QUERIES : [...QUERIES, ...BOUNDARY_QUERIES]).map(q => [q.id, expectedIndexes(q, count).length])) };
    })) };
}
