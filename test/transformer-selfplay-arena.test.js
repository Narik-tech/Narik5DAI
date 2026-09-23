import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosition, generateActions } from '../src/rules.js';
import { analyze } from '../src/search.js';
import { decidePromotion, evaluateCandidate } from '../scripts/transformer-selfplay-arena.js';

const tiny = () => createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[2rk/4/4/KR2:0:1:w]' });
const mating = () => createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[Promotions "Q,R,B,N"]\n[3k/1P2/4/K3:0:1:w]' });
const terminal = () => createPosition({ pgn: '[Board "Custom"]\n[Size "3x3"]\n[1q1/2k/K2:0:1:w]' });
const limits = { maxPlies: 1, maxNodes: 1000, maxDepth: 1, timeMs: 10000 };

function firstLegal(position) {
  const iterator = generateActions(position);
  let bestAction;
  try { bestAction = iterator.next().value?.moves ?? null; }
  finally { iterator.return(); }
  return { bestAction, pv: bestAction ? [bestAction] : [], status: 'ok', completed: true,
    nodes: 2, searchNodes: 1, generationNodes: 1, stoppedReason: 'depth', score: 99999 };
}

function syntheticPairs(outcomes, { duplicate = false, unplayed = false } = {}) {
  const games = [], pairs = [];
  for (const [index, results] of outcomes.entries()) {
    const initialKey = duplicate ? 'same' : `position-${index}`, gameIndices = [];
    for (const [aColor, result] of results.entries()) {
      const winnerColor = result === 'DRAW' ? null : result === 'A_WIN' ? aColor : 1 - aColor;
      const moves = unplayed ? [] : [{ engine: aColor === 0 ? 'A' : 'B', search: { completed: true } },
        { engine: aColor === 1 ? 'A' : 'B', search: { completed: true } }];
      gameIndices.push(games.length);
      games.push({ aColor, initialKey, result, valid: true, plies: moves.length, moves,
        certificate: { terminal: true, verified: true, winnerColor, status: result === 'DRAW' ? 'stalemate' : 'checkmate' } });
    }
    pairs.push({ initialKey, gameIndices });
  }
  return { games, pairs };
}

test('promotion requires a strict winning margin and enough distinct complete played pairs', () => {
  const winning = syntheticPairs(Array(4).fill(['A_WIN', 'A_WIN']));
  assert.equal(decidePromotion(winning).promote, true);
  assert.equal(decidePromotion(winning).candidateScore, 1);
  const tied = syntheticPairs(Array(4).fill(['A_WIN', 'B_WIN']));
  assert.equal(decidePromotion({ ...tied, promotionScore: 0.5 }).reason, 'no-winning-margin');
  const duplicate = syntheticPairs(Array(4).fill(['A_WIN', 'A_WIN']), { duplicate: true });
  assert.equal(decidePromotion(duplicate).eligiblePairs, 1);
  assert.equal(decidePromotion(duplicate).promote, false);
  const unplayed = syntheticPairs(Array(4).fill(['A_WIN', 'A_WIN']), { unplayed: true });
  assert.equal(decidePromotion(unplayed).eligiblePairs, 0);
});

test('unfinished pairs never score and any invalid game vetoes otherwise winning promotion', () => {
  const report = syntheticPairs(Array(5).fill(['A_WIN', 'A_WIN']));
  report.games.at(-1).result = 'UNFINISHED';
  assert.equal(decidePromotion(report).eligiblePairs, 4);
  assert.equal(decidePromotion(report).candidatePoints, 8);
  report.games.at(-1).valid = false;
  assert.equal(decidePromotion(report).reason, 'invalid-games');
  report.games.at(-1).valid = true;
  report.games[0].certificate.verified = false;
  assert.equal(decidePromotion(report).eligiblePairs, 3);
  assert.equal(decidePromotion(report).promote, false);
});

test('gate rejects mismatched starts, wrong color pairs, fake terminal results and below-threshold scores', () => {
  const report = syntheticPairs([['A_WIN', 'DRAW'], ['A_WIN', 'B_WIN']]);
  assert.equal(decidePromotion({ ...report, minPairs: 2, promotionScore: 0.7 }).reason, 'below-promotion-score');
  report.games[0].initialKey = 'different';
  assert.equal(decidePromotion({ ...report, minPairs: 1 }).eligiblePairs, 1);
  report.games[2].aColor = 1;
  assert.equal(decidePromotion({ ...report, minPairs: 1 }).eligiblePairs, 0);
  const fake = syntheticPairs([['A_WIN', 'A_WIN']]);
  fake.games[0].certificate.winnerColor = 1;
  assert.equal(decidePromotion({ ...fake, minPairs: 1 }).eligiblePairs, 0);
});

test('arena rotates deterministically, deduplicates complete positions, swaps colors and leaves inputs untouched', async () => {
  const suite = { cases: [{ id: 'tiny', position: tiny() }, { id: 'duplicate', position: tiny() }, { id: 'mating', position: mating() }] };
  const original = structuredClone(suite), calls = [], observed = [];
  const engine = name => async (position, options) => {
    calls.push({ name, color: position.action % 2, options });
    return firstLegal(position);
  };
  const report = await evaluateCandidate({ candidate: engine('A'), incumbent: engine('B'), suite, pairs: 4,
    minPairs: 4, seed: 1, ...limits, onGame: game => { observed.push(game.aColor); game.valid = false; } });
  assert.deepEqual(suite, original);
  assert.deepEqual(report.scheduledCases, ['duplicate', 'mating']);
  assert.deepEqual(report.skippedCases.map(item => item.reason), ['duplicate-position']);
  assert.deepEqual(observed, [0, 1, 0, 1]);
  assert.deepEqual(calls.map(call => call.name), ['A', 'B', 'A', 'B']);
  assert(calls.every(call => call.options.engine === 'transformer' && typeof call.options.shouldStop === 'function'));
  assert(report.games.every(game => game.valid));
  assert(report.pairs.every(pair => report.games[pair.gameIndices[0]].initialKey === report.games[pair.gameIndices[1]].initialKey));
  assert.equal(report.decision.promote, false);
});

test('terminal starts never run engines or count towards a minimum', async () => {
  const unused = async () => { throw new Error('should not run'); };
  const report = await evaluateCandidate({ candidate: unused, incumbent: unused,
    suite: { cases: [{ id: 'terminal', position: terminal() }] }, pairs: 1, minPairs: 1, ...limits });
  assert.equal(report.games.length, 0);
  assert.equal(report.skippedCases[0].reason, 'terminal-start');
  assert.equal(report.decision.promote, false);
});

test('real one-turn mates complete a balanced meaningful pair and do not promote a tie', async () => {
  const engine = async (position, options) => analyze(position, options);
  const report = await evaluateCandidate({ candidate: engine, incumbent: engine,
    suite: { cases: [{ id: 'mate', position: mating() }] }, pairs: 1, minPairs: 1, ...limits });
  assert.equal(report.decision.eligiblePairs, 1);
  assert.equal(report.decision.candidateScore, 0.5);
  assert.equal(report.decision.promote, false);
  assert(report.games.every(game => game.plies === 1 && game.reason === 'checkmate'));
});

test('cancellation rejects before games and while awaiting an unresponsive engine', async () => {
  const suite = { cases: [{ id: 'tiny', position: tiny() }] };
  await assert.rejects(evaluateCandidate({ candidate: firstLegal, incumbent: firstLegal, suite,
    shouldStop: () => true, ...limits }), { name: 'AbortError' });
  let cancelled = false;
  const timer = setTimeout(() => { cancelled = true; }, 40);
  try {
    await assert.rejects(evaluateCandidate({ candidate: () => new Promise(() => {}), incumbent: firstLegal,
      suite, shouldStop: () => cancelled, ...limits }), { name: 'AbortError' });
  } finally { clearTimeout(timer); }
});

test('engine cancellation and mutation are handled without forgiving invalid games', async () => {
  const suite = { cases: [{ id: 'tiny', position: tiny() }] };
  await assert.rejects(evaluateCandidate({ candidate: position => ({ ...firstLegal(position), stoppedReason: 'cancelled' }),
    incumbent: firstLegal, suite, ...limits }), { name: 'AbortError' });
  const report = await evaluateCandidate({ candidate: position => { position.action += 2; return firstLegal(position); },
    incumbent: firstLegal, suite, pairs: 1, minPairs: 1, ...limits });
  assert.equal(report.decision.reason, 'invalid-games');
  assert.equal(report.games[0].reason, 'input-mutation');
});

test('invalid arena configuration is rejected before play', async () => {
  const base = { candidate: firstLegal, incumbent: firstLegal, suite: { cases: [{ id: 'tiny', position: tiny() }] } };
  for (const patch of [{ pairs: 0 }, { minPairs: 0 }, { seed: -1 }, { promotionScore: 0.49 }, { timeMs: 0 }]) {
    await assert.rejects(evaluateCandidate({ ...base, ...patch }));
  }
});
