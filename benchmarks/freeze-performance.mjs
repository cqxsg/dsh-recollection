import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { corpusManifest } from './corpus.mjs';
const path = new URL('./performance-manifest.json', import.meta.url), manifest = corpusManifest();
if (process.argv.includes('--write')) await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
else assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), manifest, 'Frozen performance data/queries changed; version and review the manifest explicitly.');
console.log(`Verified ${manifest.data.length} fixed data sets and ${manifest.queries.length} regular queries.`);
