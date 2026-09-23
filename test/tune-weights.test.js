import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tacticalRegressions } from '../scripts/tune-weights.js';

test('a new tactical solve cannot hide a lost baseline solve at the same work budget', () => {
  const reference = { results: [
    { id: 'mate', budget: 1000, solved: true },
    { id: 'capture', budget: 1000, solved: false },
  ] };
  const candidate = { results: [
    { id: 'mate', budget: 1000, solved: false },
    { id: 'capture', budget: 1000, solved: true },
  ] };
  assert.deepEqual(tacticalRegressions(reference, candidate), [{ id: 'mate', budget: 1000 }]);
});

test('tactical gates compare each budget separately and reject missing solved cases', () => {
  const reference = { results: [
    { id: 'mate', budget: 1000, solved: true },
    { id: 'mate', budget: 5000, solved: true },
    { id: 'capture', budget: 1000, solved: false },
  ] };
  assert.deepEqual(tacticalRegressions(reference, { results: [{ id: 'mate', budget: 5000, solved: true }] }),
    [{ id: 'mate', budget: 1000 }]);
  assert.deepEqual(tacticalRegressions(reference, { results: [
    { id: 'mate', budget: 5000, solved: true },
    { id: 'capture', budget: 1000, solved: true },
    { id: 'mate', budget: 1000, solved: true },
  ] }), []);
});

test('a baseline without analyze is rejected before creating an experiment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narik-tune-review-'));
  const files = ['package.json', 'search.js', 'evaluate.js'];
  try {
    await writeFile(join(directory, files[0]), '{"type":"module"}');
    await writeFile(join(directory, files[1]), 'export const unrelated = true;\n');
    await writeFile(join(directory, files[2]), 'export {};\n');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/tune-weights.js', import.meta.url)),
      '--baseline', directory, '--output', join(directory, 'output'), '--tactics-only'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Baseline search\.js must export an analyze function/);
    await assert.rejects(access(join(directory, 'output')), { code: 'ENOENT' });
  } finally {
    for (const file of files) await unlink(join(directory, file));
    await rmdir(directory);
  }
});
