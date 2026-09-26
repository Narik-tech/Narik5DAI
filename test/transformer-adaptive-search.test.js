import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/transformer-search.js';
import { applyMove, createPosition, inCheck, parseMove, positionKey, raw, validateAction } from '../src/rules.js';

const limits = { unlimitedTime: true, maxNodes: 50000, maxDepth: 1 };
const board = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];

test('a capped candidate set can select an optional temporal turn without admitting optional spatial moves', async () => {
  const start = { board: [[board()], null, [board(), board(), board()]], action: 0,
    promotions: [10, 9, 8, 7, 6, 5, 4, 3] };
  const jump = parseMove(start, [[2, 2, 0, 0], [0, 0, 0, 1]]);
  const favorite = positionKey(validateAction(start, [jump]));
  const result = await analyze(start, { ...limits, candidateLimit: 4,
    initialCandidates: 4, componentBatchSize: 1, tacticalExtensionDepth: 0,
    scoreMoves: async (_current, moves) => moves.map(move => JSON.stringify(move) === JSON.stringify(jump) ? 100 : 0),
    evaluateBatch: async positions => positions.map(pos => positionKey(pos) === favorite ? 700 : 0),
  });
  assert.deepEqual(result.bestAction, [jump]);
  assert.equal(result.score, 700);
  assert.equal(result.rankings[0].total, 4);
  assert.equal(result.optionalMovePolicy, 'temporal-only');
  assert(result.policyCalls > 0);
  let current = start;
  for (const action of result.pv) {
    for (const move of action) {
      const present = raw.boardFuncs.present(current.board, current.action);
      assert(present.includes(move[0][0]) || move[0][0] !== move[1][0] || move[0][1] !== move[1][1]);
      current = applyMove(current, move);
    }
    current = { ...current, action: current.action + 1 };
  }
});

test('successive checking continuations extend by complete turns up to the configured tactical bound', async () => {
  // Qd2+ Qxd2+ Kc4: Black's evasion gives a countercheck, requiring a
  // second extension. All three actions are ordinary legal complete turns.
  const start = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[RK2/r2q/Q3/3k:0:1:w]' });
  const planned = [
    [[[0, 0, 1, 0], [0, 0, 1, 3]]],
    [[[0, 1, 2, 3], [0, 1, 1, 3]]],
    [[[0, 2, 3, 1], [0, 2, 3, 2]]],
  ];
  let current = start;
  for (const [index, moves] of planned.entries()) {
    current = validateAction(current, moves);
    assert.equal(inCheck(current), index < 2);
  }
  for (const extension of [0, 1, 2]) {
    const result = await analyze(start, { ...limits, candidateLimit: 1, innerCandidateLimit: 1,
      initialCandidates: 1, componentBatchSize: 1, tacticalExtensionDepth: extension,
      scoreMoves: async (pos, moves) => moves.map(move => JSON.stringify(move) === JSON.stringify(planned[pos.action]?.[0]) ? 100 : 0),
      evaluateBatch: async positions => positions.map(() => 0),
    });
    assert.equal(result.depth, 1 + extension);
    assert.equal(result.effectiveQuiescenceDepth, extension);
    assert.equal(result.qnodes, extension);
    assert.deepEqual(result.pv, planned.slice(0, 1 + extension));
    assert.equal(result.stoppedReason, 'depth');
    assert.equal(result.mateProven, false);
  }
});
