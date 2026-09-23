import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateDetailed } from '../src/evaluate.js';
import { analyze, MATE_SCORE } from '../src/search.js';
import { createPosition, parseMove, positionKey, validateAction } from '../src/rules.js';

test('search preserves its timeline reserve when a quiet branch offers no strong continuation', () => {
  const position = createPosition({ pgn: '1. Nf3 / Nf6 2. Nc3 / Nc6' });
  const original = positionKey(position);
  const quietTravel = parseMove(position, '(0T3)Nc3>>(0T2)c5');
  const branch = validateAction(position, [quietTravel]);
  assert(branch.board[2], 'The quiet travel is legal and creates a new White timeline.');
  assert(evaluateDetailed(branch).timelines < evaluateDetailed(position).timelines);

  const result = analyze(position, { maxDepth: 2, quiescenceDepth: 1, maxNodes: 10000, timeMs: 30000 });
  assert.equal(result.depth, 2);
  assert.equal(result.stoppedReason, 'depth');
  assert(result.bestAction.every(([from, to]) => from[0] === to[0] && from[1] === to[1]),
    'Search should prefer an ordinary move to a speculative branch.');
  const preferred = validateAction(position, result.bestAction);
  assert.equal(preferred.board[2], undefined);
  assert(evaluateDetailed(preferred).total > evaluateDetailed(branch).total);
  assert.equal(positionKey(position), original);
});

test('a forced temporal mate still outweighs the cost of spending a timeline reserve', async () => {
  const pgn = await readFile(new URL('../examples/tactics/temporal-knight-mate.5dpgn', import.meta.url), 'utf8');
  const position = createPosition({ pgn });
  const result = analyze(position, { maxDepth: 2, quiescenceDepth: 1, maxNodes: 5000, timeMs: 30000 });
  assert.deepEqual(result.bestAction, [[[0, 2, 1, 1], [0, 0, 3, 1]]]);
  assert.equal(result.score, MATE_SCORE - 1);
  assert.equal(result.mateIn, 1);
  const after = validateAction(position, result.bestAction);
  assert(after.board[2]);
  assert(evaluateDetailed(after).timelines < evaluateDetailed(position).timelines);
});

test('a transfer to an existing frontier does not spend an additional timeline reserve', () => {
  const square = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
  const first = square();
  first[1][1] = 4;
  const position = {
    board: [[first], null, [square(), square(), square()]],
    action: 0,
    promotions: [10, 9, 8, 7, 6, 5, 4, 3],
  };
  const after = validateAction(position, [[[0, 0, 1, 1], [2, 2, 1, 1]]]);
  assert.equal(after.board[4], undefined);
  assert.equal(after.board[0][1][1][1], 0);
  assert.equal(after.board[2][3][1][1], 4);
  const beforeScore = evaluateDetailed(position), afterScore = evaluateDetailed(after);
  assert.equal(afterScore.material, beforeScore.material);
  assert.equal(afterScore.timelines, beforeScore.timelines);
});
