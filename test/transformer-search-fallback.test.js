import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/transformer-search.js';
import { canSubmit, createPosition, generateActions, positionKey, raw, validateAction } from '../src/rules.js';

const limits = { timeMs: 10000, maxNodes: 100000, maxDepth: 1, candidateLimit: 256 };
const board = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
const timeline = length => Array.from({ length }, board);
const position = (action, timelines) => ({ board: timelines, action, promotions: [10, 9, 8, 7, 6, 5, 4, 3] });

function requiredActions(start) {
  return [...generateActions(start, { orderMoves: (current, moves) => {
    const present = raw.boardFuncs.present(current.board, current.action);
    return moves.filter(move => present.includes(move[0][0]));
  } })];
}

function assertIncomplete(start, result, reason = 'cancelled') {
  assert.equal(result.stoppedReason, reason);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completed, false);
  assert.equal(result.depth, 0);
  assert.equal(result.rootActionsSearched, 0, 'the interruption must occur while assembling root candidates');
  assert.deepEqual(result.pv, [result.bestAction]);
  const submitted = validateAction(start, result.bestAction);
  assert.equal(submitted.action, start.action + 1);
  return submitted;
}

for (const [color, action, side] of [['White', 0, 1], ['Black', 1, -1]]) {
  test(`${color} retains a scored root submission when the node budget expires before its first yield`, async () => {
    const start = createPosition(action ? { pgn: '1. e4' } : {});
    const choices = [...generateActions(start)], favorite = choices.at(-1);
    const wanted = positionKey(favorite.position);
    assert.notDeepEqual(favorite.moves, choices[0].moves);
    // This budget finishes the initial 20-successor evaluation batch but leaves
    // no work for traversing even the first model-ordered root continuation.
    const result = await analyze(start, { ...limits, maxNodes: 125,
      evaluateBatch: async positions => positions.map(pos => side * (positionKey(pos) === wanted ? 750 : 100)),
    });
    assert.equal(result.nodes, 125);
    assert.equal(result.evaluations, 20);
    assert.equal(result.inferenceBatches, 1);
    assert.equal(positionKey(assertIncomplete(start, result, 'nodes')), wanted);
    assert.deepEqual(result.bestAction, favorite.moves);
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
  });

  test(`${color} retains earlier full-turn scores when a later batch exceeds the deadline before root yield`, async t => {
    const squares = Array.from({ length: 12 }, () => Array(12).fill(0));
    squares[0][0] = 12; squares[11][11] = 11;
    for (const rank of [1, 3, 5, 7, 9]) {
      for (const file of [1, 3, 5, 7]) squares[rank][file] = 6;
    }
    const oriented = action ? squares.toReversed().map(row => row.toReversed()
      .map(piece => piece === 0 ? 0 : piece % 2 ? piece + 1 : piece - 1)) : squares;
    const start = position(action, [Array.from({ length: action + 1 }, () => structuredClone(oriented))]);
    const first = generateActions(start).next().value;
    let now = 0, batches = 0, wanted;
    t.mock.method(performance, 'now', () => now);
    const result = await analyze(start, { ...limits,
      evaluateBatch: async positions => {
        batches++;
        for (const pos of positions) assert.equal(pos.action, action + 1);
        if (batches === 1) {
          assert.equal(positions.length, 128, 'the root component alternatives must span multiple service batches');
          wanted = positionKey(positions.at(-1));
          return positions.map(pos => side * (positionKey(pos) === wanted ? 750 : 100));
        }
        now = limits.timeMs + 1;
        return positions.map(() => side * 90000);
      },
    });
    assert.equal(batches, 2);
    assert.equal(result.evaluations, 128, 'the expired batch must be discarded');
    assert.notEqual(wanted, positionKey(first.position));
    assert.equal(positionKey(assertIncomplete(start, result, 'time')), wanted);
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
    assert.equal(result.mateProven, false);
  });

  test(`${color} retains the best scored root submission when later optional assembly is cancelled`, async () => {
    const start = position(action, [timeline(action + 1), null, timeline(action + 3)]);
    const first = generateActions(start).next().value;
    const required = requiredActions(start), favorite = required.at(-1);
    assert(required.length > 1);
    assert.notDeepEqual(favorite.moves, first.moves, 'the chosen move must differ from the raw fallback');
    const wanted = positionKey(favorite.position);
    let batches = 0, stop = false;
    const result = await analyze(start, { ...limits, shouldStop: () => stop,
      evaluateBatch: async positions => {
        // The first batch scores required submissions. The next batch begins
        // only after those submissions were yielded and optional work starts.
        if (++batches === 2) stop = true;
        return positions.map(pos => side * (positionKey(pos) === wanted ? 750 : 100));
      },
    });
    assert.equal(batches, 2);
    assert.equal(positionKey(assertIncomplete(start, result)), wanted);
    assert.deepEqual(result.bestAction, favorite.moves);
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
    assert.equal(result.mateProven, false);
  });

  test(`${color} improves a multi-board fallback using submitted scores, never incomplete component scores`, async () => {
    const start = position(action, Array.from({ length: 3 }, () => timeline(action + 1)));
    let stop = false, completedBatches = 0, incompleteEvaluations = 0, wanted;
    const result = await analyze(start, { ...limits, shouldStop: () => stop,
      evaluateBatch: async positions => {
        // Cancel the first later batch after two groups of complete turns have
        // been scored and yielded. No wall-clock timing controls interruption.
        if (completedBatches === 2) stop = true;
        const submitted = positions.filter(pos => pos.action === action + 1);
        if (!stop && submitted.length) {
          completedBatches++;
          if (completedBatches === 2) wanted = positionKey(submitted.at(-1));
        }
        return positions.map(pos => {
          if (pos.action === action) {
            assert.equal(canSubmit(pos), false);
            incompleteEvaluations++;
            return side * 90000;
          }
          return side * (positionKey(pos) === wanted ? 750 : 250);
        });
      },
    });
    assert.equal(completedBatches, 2);
    assert(incompleteEvaluations > 0, 'the fixture must evaluate incomplete turns with stronger component scores');
    assert.equal(positionKey(assertIncomplete(start, result)), wanted);
    assert(result.bestAction.length >= 3, 'the scored fallback must advance every required board');
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
    assert.equal(result.mateProven, false);
  });

  test(`${color} keeps an unscored legal fallback when only incomplete components were evaluated`, async () => {
    const start = position(action, Array.from({ length: 3 }, () => timeline(action + 1)));
    const first = generateActions(start).next().value;
    let batches = 0, acceptedEvaluations = 0, stop = false;
    const result = await analyze(start, { ...limits, shouldStop: () => stop,
      evaluateBatch: async positions => {
        if (++batches === 2) stop = true;
        if (!stop) {
          for (const pos of positions) {
            assert.equal(pos.action, action);
            assert.equal(canSubmit(pos), false);
          }
          acceptedEvaluations += positions.length;
        }
        return positions.map(() => side * 90000);
      },
    });
    assert.equal(batches, 2);
    assert(acceptedEvaluations > 0);
    assert.equal(result.evaluations, acceptedEvaluations);
    assertIncomplete(start, result);
    assert.deepEqual(result.bestAction, first.moves);
    assert.equal(result.score, null);
    assert.equal(result.scoreType, 'unavailable');
    assert.equal(result.mateProven, false);
  });
}
