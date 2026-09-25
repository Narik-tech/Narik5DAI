import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArguments, workerAnalyzer } from '../scripts/transformer-selfplay.js';
import { evaluateCandidate } from '../scripts/transformer-selfplay-arena.js';
import { createPosition } from '../src/rules.js';

test('self-play CLI defaults to one bounded cycle and accepts continuous mode', () => {
  const defaults = parseArguments([]);
  assert.equal(defaults.iterations, 1);
  assert.equal(defaults.gameConcurrency, 1);
  assert.equal(defaults.arenaConcurrency, 1);
  assert.equal(defaults.device, process.env.TRANSFORMER_DEVICE || 'auto');
  assert.ok(defaults.minPairs <= defaults.arenaPairs);
  const options = parseArguments(['--iterations', '0', '--seed-data', 'none', '--device', 'cpu', '--steps', '3', '--game-concurrency', '4', '--arena-concurrency', '3']);
  assert.equal(options.iterations, 0);
  assert.equal(options.seedData, undefined);
  assert.equal(options.steps, 3);
  assert.equal(options.gameConcurrency, 4);
  assert.equal(options.arenaConcurrency, 3);
  assert.equal(parseArguments(['--depth', '64']).maxDepth, 64);
});

test('self-play CLI rejects malformed limits and unsafe promotion thresholds', () => {
  for (const args of [ ['--games', '0'], ['--steps', '1.5'], ['--nodes', 'NaN'], ['--iterations', '-1'],
    ['--game-concurrency', '0'], ['--game-concurrency', '9'], ['--game-concurrency', '1.5'], ['--game-concurrency', 'NaN'],
    ['--arena-concurrency', '0'], ['--arena-concurrency', '9'], ['--arena-concurrency', '1.5'], ['--arena-concurrency', 'NaN'],
    ['--exploration', '1.1'], ['--outcome-weight', '-.1'], ['--promotion-score', '.5'], ['--depth', '65'],
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

test('parallel search workers share inference and route independent evaluations correctly', async () => {
  let active = 0, peak = 0, calls = 0;
  const runtime = {
    start: async () => ({ model: {} }),
    async evaluate(positions) {
      calls++; peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { values: positions.map(() => 75) };
    },
  };
  const analyzer = workerAnalyzer(runtime, undefined, 3);
  try {
    const results = await Promise.all(Array.from({ length: 3 }, () => analyzer(createPosition(), {
      maxDepth: 1, maxNodes: 20000, timeMs: 10000,
    })));
    assert.ok(calls >= 3);
    assert.equal(peak, 1);
    for (const result of results) {
      assert.equal(result.completed, true);
      assert.equal(result.engine, 'transformer');
      assert.equal(result.score, 75);
      assert.ok(result.bestAction.length);
    }
  } finally { await analyzer.close(); }
});

test('parallel arena workers use the correct model for both color assignments', async () => {
  const models = new Set();
  let release;
  const bothModels = new Promise(resolve => { release = resolve; });
  const runtime = (name, score) => ({
    start: async () => ({ model: { name } }),
    async evaluate(positions) {
      models.add(name);
      if (models.size === 2) release();
      await bothModels;
      return { values: positions.map(() => score) };
    },
  });
  const candidate = workerAnalyzer(runtime('candidate', 75), undefined, 2);
  const incumbent = workerAnalyzer(runtime('incumbent', -75), undefined, 2);
  try {
    const arena = await evaluateCandidate({ candidate, incumbent,
      suite: { cases: [{ id: 'tiny', position: createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[2rk/4/4/KR2:0:1:w]' }) }] },
      pairs: 1, minPairs: 1, gameConcurrency: 2, maxPlies: 1, maxDepth: 1, maxNodes: 20000, timeMs: 10000,
    });
    assert.equal(models.size, 2, 'both model workers must reach inference concurrently');
    assert.deepEqual(arena.games.map(game => game.aColor), [0, 1]);
    for (const [index, game] of arena.games.entries()) {
      assert.equal(game.valid, true);
      assert.equal(game.plies, 1);
      assert.equal(game.moves[0].engine, index === 0 ? 'A' : 'B');
      assert.equal(game.moves[0].search.score, index === 0 ? 75 : -75);
    }
  } finally { release(); await Promise.all([candidate.close(), incumbent.close()]); }
});

test('closing a shared analyzer cancels and drains every search worker', async () => {
  const analyzer = workerAnalyzer({ start: async () => ({ model: {} }), evaluate: async () => new Promise(() => {}) }, undefined, 2);
  const requests = Array.from({ length: 3 }, () => assert.rejects(analyzer(createPosition(), {
    maxDepth: 2, maxNodes: 20000, timeMs: 10000,
  }), { name: 'AbortError' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  await analyzer.close();
  await Promise.all(requests);
  await assert.rejects(analyzer(createPosition(), { timeMs: 10000 }), { name: 'AbortError' });
});
