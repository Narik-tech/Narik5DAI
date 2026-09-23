import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArguments, workerAnalyzer } from '../scripts/transformer-selfplay.js';
import { createPosition } from '../src/rules.js';

test('self-play CLI defaults to one bounded cycle and accepts continuous mode', () => {
  const defaults = parseArguments([]);
  assert.equal(defaults.iterations, 1);
  assert.equal(defaults.device, process.env.TRANSFORMER_DEVICE || 'auto');
  assert.ok(defaults.minPairs <= defaults.arenaPairs);
  const options = parseArguments(['--iterations', '0', '--seed-data', 'none', '--device', 'cpu', '--steps', '3']);
  assert.equal(options.iterations, 0);
  assert.equal(options.seedData, undefined);
  assert.equal(options.steps, 3);
});

test('self-play CLI rejects malformed limits and unsafe promotion thresholds', () => {
  for (const args of [ ['--games', '0'], ['--steps', '1.5'], ['--nodes', 'NaN'], ['--iterations', '-1'],
    ['--exploration', '1.1'], ['--outcome-weight', '-.1'], ['--promotion-score', '.5'],
    ['--arena-pairs', '2', '--min-pairs', '3'], ['--batch-size', '129'], ['--device', 'bogus'], ['--steps'], ['--bogus', '1'] ]) {
    assert.throws(() => parseArguments(args), undefined, args.join(' '));
  }
});

test('stripped npm option names produce actionable guidance instead of guessing positional values', () => {
  assert.throws(() => parseArguments(['0', 'cuda']), /npm\/PowerShell.*node scripts\/transformer-selfplay\.js --iterations 0 --device cuda/);
  const direct = parseArguments(['--iterations', '0', '--device', 'cuda']);
  assert.equal(direct.iterations, 0);
  assert.equal(direct.device, 'cuda');
});

test('retention cannot own active checkpoint or training input paths', () => {
  const run = path.resolve('artifacts/test-selfplay');
  for (const flag of ['--checkpoint', '--seed-data', '--suite', '--arena-suite', '--python']) {
    assert.throws(() => parseArguments(['--run-dir', run, flag, path.join(run, 'iteration-00000001', 'input.pt')]), /managed iteration/);
  }
  assert.throws(() => parseArguments(['--run-dir', run, '--seed-data', path.join(run, 'replay.jsonl')]), /replay.jsonl/);
  for (const file of ['run.json', 'latest.json', 'previous-model.pt', 'replay.jsonl', '.selfplay.lock']) {
    assert.throws(() => parseArguments(['--run-dir', run, '--checkpoint', path.join(run, file)]), /managed output/);
  }
});

test('worker transport honors a per-search cancellation callback and terminates its worker', async () => {
  let stop = false;
  const runtime = { start: async () => ({ model: {} }), evaluate: async () => new Promise(() => {}) };
  const timer = setTimeout(() => { stop = true; }, 50);
  try {
    await assert.rejects(workerAnalyzer(runtime)(createPosition(), {
      maxDepth: 2, maxNodes: 20000, timeMs: 1000, shouldStop: () => stop,
    }), { name: 'AbortError' });
  } finally { clearTimeout(timer); }
});
