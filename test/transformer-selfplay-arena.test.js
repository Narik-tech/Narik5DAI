import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosition, generateActions, positionKey, validateAction } from '../src/rules.js';
import { analyze } from '../src/search.js';
import { analyze as analyzeTransformer } from '../src/transformer-search.js';
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

test('completion rates include unfinished games and distinguish certified, complete and eligible results', () => {
  const report = syntheticPairs(Array(5).fill(['A_WIN', 'A_WIN']));
  Object.assign(report.games[3], { result: 'UNFINISHED', reason: 'ply-limit' });
  for (const index of report.pairs[2].gameIndices) Object.assign(report.games[index], { moves: [], plies: 0 });
  report.pairs[3].initialKey = report.pairs[0].initialKey;
  for (const index of report.pairs[3].gameIndices) report.games[index].initialKey = report.pairs[0].initialKey;
  Object.assign(report.games[9], { result: 'UNFINISHED', valid: false, reason: 'engine-error' });

  const decision = decidePromotion({ ...report, minPairs: 1 });
  assert.equal(decision.reason, 'invalid-games');
  assert.equal(decision.candidateScore, 1);
  assert.equal(decision.candidatePoints, 2);
  assert.deepEqual(decision.completion, {
    totalGames: 10, certifiedGames: 8, gameCompletionRate: 0.8,
    unfinishedReasons: { 'ply-limit': 1, 'engine-error': 1 },
    totalPairs: 5, completePairs: 3, pairCompletionRate: 0.6,
    eligiblePairs: 1, eligiblePairRate: 0.2,
    byCandidateColor: {
      white: { totalGames: 5, certifiedGames: 5, gameCompletionRate: 1, unfinishedReasons: {} },
      black: { totalGames: 5, certifiedGames: 3, gameCompletionRate: 0.6,
        unfinishedReasons: { 'ply-limit': 1, 'engine-error': 1 } },
    },
  });
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
  assert.equal(decidePromotion({ ...fake, minPairs: 1 }).completion.certifiedGames, 1);
  assert.equal(decidePromotion({ ...fake, minPairs: 1 }).completion.gameCompletionRate, 0.5);
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
  assert.deepEqual(report.summary.completion, report.decision.completion);
  assert.equal(report.summary.completion.totalPairs, 2);
  assert.equal(report.summary.completion.totalGames, 4);
});

test('terminal starts never run engines or count towards a minimum', async () => {
  const unused = async () => { throw new Error('should not run'); };
  const report = await evaluateCandidate({ candidate: unused, incumbent: unused,
    suite: { cases: [{ id: 'terminal', position: terminal() }] }, pairs: 1, minPairs: 1, ...limits });
  assert.equal(report.games.length, 0);
  assert.equal(report.skippedCases[0].reason, 'terminal-start');
  assert.equal(report.decision.promote, false);
  assert.deepEqual(report.decision.completion, {
    totalGames: 0, certifiedGames: 0, gameCompletionRate: null, unfinishedReasons: {},
    totalPairs: 0, completePairs: 0, pairCompletionRate: null, eligiblePairs: 0, eligiblePairRate: null,
    byCandidateColor: {
      white: { totalGames: 0, certifiedGames: 0, gameCompletionRate: null, unfinishedReasons: {} },
      black: { totalGames: 0, certifiedGames: 0, gameCompletionRate: null, unfinishedReasons: {} },
    },
  });
});

test('real one-turn mates complete a balanced meaningful pair and do not promote a tie', async () => {
  const engine = async (position, options) => analyze(position, options);
  const report = await evaluateCandidate({ candidate: engine, incumbent: engine,
    suite: { cases: [{ id: 'mate', position: mating() }] }, pairs: 1, minPairs: 1, ...limits });
  assert.equal(report.decision.eligiblePairs, 1);
  assert.equal(report.decision.candidateScore, 0.5);
  assert.equal(report.decision.promote, false);
  assert(report.games.every(game => game.plies === 1 && game.reason === 'checkmate'));
  assert.equal(report.summary.completion.gameCompletionRate, 1);
  assert.equal(report.summary.completion.pairCompletionRate, 1);
  assert.equal(report.summary.completion.eligiblePairRate, 1);
});

test('arena plays completed and incomplete time-limited legal actions with both color assignments', async () => {
  for (const completed of [true, false]) {
    const engine = position => ({ ...firstLegal(position), completed, stoppedReason: 'time',
      status: completed ? 'ok' : 'incomplete', score: completed ? 42 : null });
    const report = await evaluateCandidate({ candidate: engine, incumbent: engine,
      suite: { cases: [{ id: 'tiny', position: tiny() }] }, pairs: 1, minPairs: 1, ...limits, maxPlies: 2 });
    assert.equal(report.limits.playOnTimeLimit, true);
    assert.deepEqual(report.games.map(game => game.aColor), [0, 1]);
    assert.deepEqual(report.games.map(game => game.moves.map(move => move.engine)), [['A', 'B'], ['B', 'A']]);
    assert.equal(report.summary.incompleteSearchMoves, completed ? 0 : 4);
    for (const game of report.games) {
      assert.equal(game.valid, true);
      assert.equal(game.plies, 2);
      assert.equal(game.reason, 'ply-limit');
      let replay = game.initialPosition;
      for (const move of game.moves) {
        assert.equal(move.search.stoppedReason, 'time');
        assert.equal(move.search.completed, completed);
        assert.equal(move.search.score, completed ? 42 : null);
        assert.equal(move.beforeKey, positionKey(replay));
        replay = validateAction(replay, move.action);
        assert.equal(move.afterKey, positionKey(replay));
      }
      assert.equal(game.finalKey, positionKey(replay));
    }
  }
});

test('arena time fallback does not forgive absent actions, illegal actions or invalid PVs', async () => {
  const illegal = [[[0, 0, 0, 0], [0, 0, 3, 3]]];
  for (const [patch, reason, valid] of [
    [{ bestAction: null, pv: [] }, 'time-limit', true],
    [{ bestAction: illegal, pv: [illegal] }, 'illegal-action', false],
    [{ pv: [illegal] }, 'invalid-pv', false],
  ]) {
    const engine = position => ({ ...firstLegal(position), completed: false,
      status: 'incomplete', stoppedReason: 'time', ...patch });
    const report = await evaluateCandidate({ candidate: engine, incumbent: engine,
      suite: { cases: [{ id: 'tiny', position: tiny() }] }, pairs: 1, minPairs: 1, ...limits });
    for (const game of report.games) {
      assert.equal(game.plies, 0);
      assert.equal(game.result, 'UNFINISHED');
      assert.equal(game.reason, reason);
      assert.equal(game.valid, valid);
    }
    assert.equal(report.decision.promote, false);
    assert.equal(report.decision.eligiblePairs, 0);
    assert.equal(report.decision.invalidGames, valid ? 0 : 2);
  }
});

test('real Transformer search retains and plays its legal fallback when inference reaches the deadline', async t => {
  let now = 0, inferenceCalls = 0;
  t.mock.method(performance, 'now', () => now);
  const engine = (position, options) => analyzeTransformer(position, { ...options, candidateLimit: 1,
    evaluateBatch: async positions => {
      inferenceCalls++;
      now += options.timeMs;
      return positions.map(() => 0);
    },
  });
  const report = await evaluateCandidate({ candidate: engine, incumbent: engine,
    suite: { cases: [{ id: 'tiny', position: tiny() }] }, pairs: 1, minPairs: 1, ...limits });
  assert.equal(inferenceCalls, 2);
  assert.equal(report.summary.incompleteSearchMoves, 2);
  for (const game of report.games) {
    assert.equal(game.valid, true);
    assert.equal(game.plies, 1);
    assert.equal(game.reason, 'ply-limit');
    assert.equal(game.moves[0].search.stoppedReason, 'time');
    assert.equal(game.moves[0].search.completed, false);
    assert.equal(game.moves[0].search.score, null);
    assert.equal(positionKey(validateAction(game.initialPosition, game.moves[0].action)), game.finalKey);
  }
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
