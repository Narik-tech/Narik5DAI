import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, MATE_SCORE } from '../src/transformer-search.js';
import { createPosition, formatAction, generateActions, inCheck, positionKey, validateAction } from '../src/rules.js';

const limits = { timeMs: 10000, maxNodes: 100000, maxDepth: 1 };
const zero = async positions => positions.map(() => 0);
function firstActions(position, count = 8) {
  const result = [];
  for (const candidate of generateActions(position)) {
    result.push(candidate);
    if (result.length === count) break;
  }
  return result;
}
function validatePv(position, result) {
  let current = position;
  for (const action of result.pv) current = validateAction(current, action);
  return current;
}
function fractionalValue(position) {
  let hash = 2166136261;
  for (const char of positionKey(position)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 2001 - 1000) / 1000;
}
// Independent exhaustive minimax over the same bounded candidate universe.
// Fractional values exercise alpha-beta bounds that must not assume integer scores.
function minimax(position, remaining, candidateLimit, innerCandidateLimit = candidateLimit, ply = 0) {
  const choices = firstActions(position, ply ? innerCandidateLimit : candidateLimit);
  const side = position.action % 2 ? -1 : 1;
  if (!choices.length) return { score: inCheck(position) ? side * (-MATE_SCORE + ply) : 0, actions: [] };
  if (!remaining) return { score: fractionalValue(position), actions: [] };
  let best = -Infinity, score, actions = [];
  for (const candidate of choices) {
    const value = minimax(candidate.position, remaining - 1, candidateLimit, innerCandidateLimit, ply + 1).score;
    if (value * side > best) { best = value * side; score = value; actions = [candidate.moves]; }
    else if (value * side === best) actions.push(candidate.moves);
  }
  return { score, actions };
}

test('neural batch values select different legal actions for White without changing the position', async () => {
  const position = createPosition(), original = structuredClone(position);
  const choices = firstActions(position);
  for (const favorite of [choices[0], choices.at(-1)]) {
    const wanted = positionKey(favorite.position), batches = [];
    const result = await analyze(position, { ...limits, candidateLimit: 8,
      evaluateBatch: async positions => { batches.push(positions.length); return positions.map(pos => positionKey(pos) === wanted ? 321 : -100); },
    });
    assert.equal(result.engine, 'transformer');
    assert.equal(result.searchPolicy, 'transformer-bounded-alpha-beta');
    assert.equal(result.depth, 1);
    assert.equal(result.score, 321);
    assert.equal(result.completed, true);
    assert.deepEqual(result.bestAction, favorite.moves);
    assert.deepEqual(batches, [8]);
    assert.equal(result.nodes, result.searchNodes + result.generationNodes);
    validatePv(position, result);
  }
  assert.deepEqual(position, original);
});

test('Black minimizes the White-perspective neural value', async () => {
  const position = createPosition({ pgn: '1. e4' });
  const favorite = firstActions(position).at(-1), wanted = positionKey(favorite.position);
  const result = await analyze(position, { ...limits, candidateLimit: 8,
    evaluateBatch: async positions => positions.map(pos => positionKey(pos) === wanted ? -475 : 200),
  });
  assert.deepEqual(result.bestAction, favorite.moves);
  assert.equal(result.score, -475);
  validatePv(position, result);
});

test('turn-zero continuations agree after submitting d4 at the same remaining depth', async () => {
  const position = createPosition({ variant: 'turn_zero' });
  const d4 = firstActions(position, 64).find(candidate => formatAction(position, candidate.moves) === '(0T1)d4');
  const replies = firstActions(d4.position, 64);
  const replyValues = new Map([['(0T1)e5', -50], ['(0T1)h5', -100], ['(0T1)Nf6', -500]]);
  const values = new Map([[positionKey(d4.position), 1000], ...replies.map(candidate => [
    positionKey(candidate.position), replyValues.get(formatAction(d4.position, candidate.moves)) ?? 100,
  ])]);
  const evaluateBatch = async positions => positions.map(pos => values.get(positionKey(pos)) ?? -1000);

  for (const [candidateOptions, expectedReply] of [[{}, '(0T1)Nf6'], [{ candidateLimit: 12 }, '(0T1)e5']]) {
    const options = { ...limits, ...candidateOptions, evaluateBatch };
    const initial = await analyze(position, { ...options, maxDepth: 2 });
    const submitted = validateAction(position, d4.moves);
    const continuation = await analyze(submitted, { ...options, maxDepth: 1 });
    assert.equal(initial.depth, 2);
    assert.equal(continuation.depth, 1);
    assert.deepEqual(initial.bestAction, d4.moves);
    assert.equal(formatAction(submitted, continuation.bestAction), expectedReply);
    assert.deepEqual(initial.pv.slice(1), continuation.pv);
    assert.equal(initial.score, continuation.score);
    validatePv(position, initial);
  }
});

test('ordered alpha-beta respects depth and returns full-turn legal PV', async () => {
  const position = createPosition(), reports = [];
  const result = await analyze(position, { ...limits, maxDepth: 3, candidateLimit: 4, innerCandidateLimit: 3, maxCachedPositions: 2,
    evaluateBatch: zero, onProgress: report => { if (report.completed) reports.push(report.depth); },
  });
  assert.equal(result.depth, 3);
  assert.equal(result.stoppedReason, 'depth');
  assert.equal(result.pv.length, 3);
  assert.equal(result.rootActionsSearched, 4);
  assert(result.cutoffs > 0);
  assert.equal('beamWidth' in result, false);
  assert.equal('beamPruned' in result, false);
  assert.equal('beamWidth' in result.limits, false);
  assert(result.candidateCacheEntries <= 2);
  assert.deepEqual([...new Set(reports)], [1, 2, 3]);
  validatePv(position, result);
});

test('a sixth-ranked shallow move remains searchable and wins at depth two', async () => {
  const position = createPosition(), choices = firstActions(position);
  const favorite = choices[5], values = new Map();
  choices.forEach((candidate, index) => {
    values.set(positionKey(candidate.position), 800 - index * 100);
    for (const reply of firstActions(candidate.position)) {
      values.set(positionKey(reply.position), candidate === favorite ? 500 : -1000);
    }
  });
  const evaluateBatch = async positions => positions.map(pos => values.get(positionKey(pos)) ?? 0);
  const shallow = await analyze(position, { ...limits, candidateLimit: 8, evaluateBatch });
  assert.deepEqual(shallow.bestAction, choices[0].moves);
  const result = await analyze(position, { ...limits, maxDepth: 2, candidateLimit: 8, evaluateBatch });
  assert.equal(result.depth, 2);
  assert.equal(result.rootActionsSearched, 8);
  assert.equal(result.score, 500);
  assert.deepEqual(result.bestAction, favorite.moves);
  assert.equal(result.pv.length, 2);
  validatePv(position, result);
});

test('ordered alpha-beta agrees with fractional minimax for both colors, horizons, and candidate caps', async () => {
  let cutoffs = 0;
  for (const position of [createPosition(), createPosition({ pgn: '1. e4' })]) {
    for (const [candidateLimit, innerCandidateLimit] of [[2, 2], [4, 4], [5, 3]]) {
      for (const maxDepth of [1, 2, 3]) {
        const expected = minimax(position, maxDepth, candidateLimit, innerCandidateLimit);
        const result = await analyze(position, { ...limits, maxDepth, candidateLimit, innerCandidateLimit,
          evaluateBatch: async positions => positions.map(fractionalValue),
        });
        const context = `side=${position.action % 2}, depth=${maxDepth}, caps=${candidateLimit}/${innerCandidateLimit}`;
        assert.equal(result.depth, maxDepth, context);
        assert.equal(result.score, Math.round(expected.score), context);
        assert(expected.actions.some(action => JSON.stringify(action) === JSON.stringify(result.bestAction)), context);
        assert.equal(result.rootActionsSearched, candidateLimit, context);
        assert.equal(result.pv.length, maxDepth, context);
        cutoffs += result.cutoffs;
        validatePv(position, result);
      }
    }
  }
  assert(cutoffs > 0, 'oracle comparisons must include actual alpha-beta pruning');
});

test('multiple active boards are evaluated and played as complete submissions', async () => {
  const position = createPosition({ variant: 'two_timelines' });
  const result = await analyze(position, { ...limits, candidateLimit: 4, evaluateBatch: zero });
  assert.equal(result.depth, 1);
  assert(result.bestAction.length >= 2);
  assert.equal(validatePv(position, result).action, 1);
});

test('larger candidate caps split inference requests at the service batch limit', async () => {
  const sizes = [];
  const result = await analyze(createPosition({ variant: 'two_timelines' }), { ...limits, candidateLimit: 256,
    evaluateBatch: async positions => { sizes.push(positions.length); return positions.map(() => 0); },
  });
  assert.equal(result.depth, 1);
  assert.deepEqual(sizes, [128, 128]);
});

test('zero budgets and candidate caps cannot fabricate terminal outcomes', async () => {
  const position = createPosition();
  for (const budget of [{ maxNodes: 0 }, { timeMs: 0 }]) {
    const result = await analyze(position, { ...limits, ...budget, evaluateBatch: zero });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.completed, false);
    assert.equal(result.score, null);
    assert.equal(result.nodes, 0);
    assert.equal(result.bestAction, null);
  }
  const capped = await analyze(position, { ...limits, candidateLimit: 1, evaluateBatch: zero });
  assert.equal(capped.status, 'ok');
  assert.equal(capped.scoreType, 'cp');
  assert(capped.candidateCaps > 0);
  validatePv(position, capped);
});

test('a small work budget preserves a legal but explicitly unscored fallback', async () => {
  const position = createPosition();
  const result = await analyze(position, { ...limits, maxNodes: 4, evaluateBatch: zero });
  assert.equal(result.nodes, 4);
  assert.equal(result.stoppedReason, 'nodes');
  assert.equal(result.completed, false);
  assert.equal(result.score, null);
  assert.equal(result.scoreType, 'unavailable');
  assert(result.bestAction);
  validatePv(position, result);
});

test('cancellation after an awaited batch discards that batch', async () => {
  const position = createPosition();
  let stop = false;
  const result = await analyze(position, { ...limits, candidateLimit: 2, shouldStop: () => stop,
    evaluateBatch: async positions => { await Promise.resolve(); stop = true; return positions.map(() => 999); },
  });
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.score, null);
  assert.equal(result.completed, false);
  validatePv(position, result);
});

test('cancellation retains the last completed iteration', async () => {
  const position = createPosition();
  let stop = false, saved;
  const result = await analyze(position, { ...limits, maxDepth: 4, candidateLimit: 4, evaluateBatch: zero,
    shouldStop: () => stop,
    onProgress: report => { if (report.completed) { saved = report; stop = true; } },
  });
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.depth, 1);
  assert.equal(result.completed, true);
  assert.deepEqual(result.pv, saved.pv);
});

test('time limit interrupts a stalled evaluator', async () => {
  let called = false;
  const before = performance.now();
  const result = await analyze(createPosition(), { ...limits, candidateLimit: 1, timeMs: 50,
    evaluateBatch: () => { called = true; return new Promise(() => {}); },
  });
  assert(called);
  assert.equal(result.stoppedReason, 'time');
  assert.equal(result.score, null);
  assert(performance.now() - before < 1000);
});

test('terminal statuses require exhausted unrestricted legal generation', async () => {
  const mate = createPosition({ pgn: '1. e3 / f6 2. Qe2 / Nc6 3. Qh5' });
  const stale = createPosition({ pgn: '[Board "Custom"]\n[Size "3x3"]\n[1q1/2k/K2:0:1:w]' });
  for (const [position, expected, score] of [[mate, 'checkmate', MATE_SCORE], [stale, 'stalemate', 0]]) {
    const result = await analyze(position, { ...limits, evaluateBatch: () => { throw new Error('Terminal requires no model call.'); } });
    assert.equal(result.status, expected);
    assert.equal(result.score, score);
    assert.equal(result.completed, true);
    assert.equal(result.bestAction, null);
    assert.equal(result.terminalProof, 'unrestricted-legal-exhaustion');
  }
});

test('mate proof survives a winning witness but requires every move for a losing claim', async () => {
  const winning = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[1q1k/4/4/K3:0:1:w]\n[1q1k/4/4/K3:0:1:b]\n[3k/4/1N2/K3:0:2:w]' });
  const won = await analyze(winning, { ...limits, evaluateBatch: zero });
  assert.equal(won.mateIn, 1);
  assert.equal(won.mateProven, true);
  validatePv(winning, won);
  const cappedWin = await analyze(winning, { ...limits, candidateLimit: 9, evaluateBatch: zero });
  assert(cappedWin.candidateCaps > 0);
  assert.equal(cappedWin.mateIn, 1);
  assert.equal(cappedWin.mateProven, true, 'a certified winning witness survives a candidate cap');
  const losing = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[4/k3/QK1q/n3:0:1:w]' });
  const lost = await analyze(losing, { ...limits, maxDepth: 3, evaluateBatch: zero });
  assert.equal(lost.mateIn, -2);
  assert.equal(lost.mateProven, true);
  const selective = await analyze(losing, { ...limits, maxDepth: 3, evaluateBatch: zero, candidateLimit: 1 });
  assert.equal(selective.mateIn, null);
  assert.equal(selective.mateProven, false);
  assert.equal(selective.scoreType, 'cp');
  validatePv(losing, selective);
  const replyCap = await analyze(losing, { ...limits, maxDepth: 3, evaluateBatch: zero, innerCandidateLimit: 1 });
  assert(replyCap.candidateCaps > 0);
  assert.equal(replyCap.mateIn, -2);
  assert.equal(replyCap.mateProven, true, 'each legal root move has a certified opponent winning witness');
});

test('a mate witness can cause a safe cutoff without claiming that every root move loses', async () => {
  const position = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[4/2q1/4/K2k:0:1:w]' });
  const safe = firstActions(position).find(candidate => formatAction(position, candidate.moves) === '(0T1)Ka2');
  const safeKey = positionKey(safe.position);
  // Search the safe move first. Black's mating reply to Kb1 then proves that
  // root alternative cannot improve the bound, without exhausting its replies.
  const result = await analyze(position, { ...limits, maxDepth: 2,
    evaluateBatch: async positions => positions.map(pos => positionKey(pos) === safeKey ? 100 : 0),
  });
  assert.equal(result.depth, 2);
  assert(result.cutoffs > 0);
  assert.equal(result.candidateCaps, 0);
  assert.deepEqual(result.bestAction, safe.moves);
  assert.equal(result.score, 0);
  assert.equal(result.mateIn, null);
  assert.equal(result.mateProven, false);
  assert.equal(result.scoreType, 'cp');
  validatePv(position, result);
});

test('neural values cannot masquerade as mate scores', async () => {
  const result = await analyze(createPosition(), { ...limits, candidateLimit: 2, evaluateBatch: async positions => positions.map(() => 1e10) });
  assert.equal(result.scoreType, 'cp');
  assert.equal(result.mateIn, null);
  assert(result.score < MATE_SCORE - 1000);
});

test('model failures and malformed value batches propagate', async () => {
  const position = createPosition();
  await assert.rejects(analyze(position), /requires evaluateBatch/);
  await assert.rejects(analyze(position, { ...limits, candidateLimit: 1, evaluateBatch: async () => { throw new Error('Model unavailable'); } }), /Model unavailable/);
  for (const bad of [[], [NaN], [Infinity], ['123']]) {
    await assert.rejects(analyze(position, { ...limits, candidateLimit: 1, evaluateBatch: async () => bad }), /finite White-centipawn/);
  }
});
