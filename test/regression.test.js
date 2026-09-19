import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, MATE_SCORE } from '../src/search.js';
import { evaluate } from '../src/evaluate.js';
import { validateAction, generateActions, inCheck } from '../src/rules.js';

test('large custom material advantages cannot enter the reserved mate score range', () => {
  // The pawn wall keeps the enormous material surplus away from the black
  // king. A heuristic score above 100,000 is not proof of checkmate.
  const squares = Array.from({ length: 16 }, (_, r) => Array(16).fill(r < 7 ? 10 : r === 7 ? 2 : 0));
  squares[0][0] = 12;
  squares[15][15] = 11;
  const position = { board: [[squares]], action: 0, promotions: [10, 9, 8, 7, 6, 5, 4, 3] };
  assert(evaluate(position) > MATE_SCORE);
  const result = analyze(position, { maxDepth: 1, quiescenceDepth: 0, timeMs: 10_000, maxNodes: 100_000 });
  assert.equal(result.completed, true);
  assert.equal(result.scoreType, 'cp');
  assert.equal(result.mateIn, null);
  assert(Math.abs(result.score) < MATE_SCORE - 1000);
  const reply = validateAction(position, result.bestAction);
  assert.equal(inCheck(reply), false);
  const iterator = generateActions(reply);
  assert.equal(iterator.next().done, false);
  iterator.return();
});
