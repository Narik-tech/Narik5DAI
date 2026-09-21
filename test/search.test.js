import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, MATE_SCORE } from '../src/search.js';
import { evaluate, evaluateDetailed } from '../src/evaluate.js';
import { createPosition, validateAction, formatAction, positionKey, inCheck } from '../src/rules.js';

const promotions = [10, 9, 8, 7, 6, 5, 4, 3];
const capturePosition = () => ({
  board: [[[[12, 0, 0, 0], [8, 0, 9, 0], [0, 0, 0, 0], [0, 0, 0, 11]]]], action: 0, promotions,
});
function validatePv(position, result) {
  let current = position;
  for (const action of result.pv) current = validateAction(current, action);
}

test('opening search completes and returns a legal full-turn principal variation', () => {
  const position = createPosition(), original = positionKey(position);
  const result = analyze(position, { timeMs: 5000, maxDepth: 3, maxNodes: 100000, quiescenceDepth: 1 });
  assert.equal(result.status, 'ok');
  assert.equal(result.depth, 3);
  assert.equal(result.completed, true);
  assert.equal(result.effectiveQuiescenceDepth, 1);
  assert(result.bestAction.length > 0);
  assert.equal(result.nodes, result.searchNodes + result.generationNodes);
  assert(result.qnodes > 0);
  assert(result.cutoffs > 0);
  assert.equal(positionKey(position), original);
  validatePv(position, result);
});

test('captures a hanging queen and reports scores from White perspective for either mover', () => {
  const white = capturePosition();
  const result = analyze(white, { timeMs: 3000, maxDepth: 2, quiescenceDepth: 1 });
  assert.deepEqual(result.bestAction[0], [[0, 0, 1, 0], [0, 0, 1, 2]]);
  assert(result.score > 500);
  validatePv(white, result);
  const flipped = white.board[0][0].toReversed().map(row => row.map(p => p === 0 ? 0 : p % 2 ? p + 1 : p - 1));
  const black = { board: [[null, flipped]], action: 1, promotions };
  const reply = analyze(black, { timeMs: 3000, maxDepth: 2, quiescenceDepth: 1 });
  assert.deepEqual(reply.bestAction[0], [[0, 1, 2, 0], [0, 1, 2, 2]]);
  assert(reply.score < -500);
  validatePv(black, reply);
});

test('finds a forced temporal mate in one complete action', () => {
  const position = createPosition({ pgn: '1. e3 / f6 2. Qe2 / Nc6' });
  const result = analyze(position, { timeMs: 5000, maxDepth: 2, maxNodes: 20000 });
  assert.match(formatAction(position, result.bestAction), /Qh5/);
  assert.equal(result.score, MATE_SCORE - 1);
  assert.equal(result.scoreType, 'mate');
  assert.equal(result.mateIn, 1);
  const after = validateAction(position, result.bestAction);
  assert(inCheck(after));
  const terminal = analyze(after, { timeMs: 3000, maxDepth: 1, maxNodes: 20000 });
  assert.equal(terminal.status, 'checkmate');
  assert.equal(terminal.bestAction, null);
  assert.equal(terminal.score, MATE_SCORE);
});

test('quiescence rejects a pawn capture that loses a knight to a recapture', () => {
  const position = createPosition({ pgn: '1. e4 / e5 2. Nf3 / Nc6' });
  const shallow = analyze(position, { timeMs: 3000, maxDepth: 1, quiescenceDepth: 0 });
  const tactical = analyze(position, { timeMs: 3000, maxDepth: 1, quiescenceDepth: 1 });
  assert.match(formatAction(position, shallow.bestAction), /Nxe5/);
  assert.doesNotMatch(formatAction(position, tactical.bestAction), /Nxe5/);
  assert.equal(tactical.effectiveQuiescenceDepth, 1);
  assert(tactical.score < shallow.score);
  validatePv(position, tactical);
});

test('stalemate is distinguished from checkmate after exhaustive legal-action generation', () => {
  const position = { board: [[[[12, 0, 0], [0, 0, 11], [0, 9, 0]]]], action: 0, promotions };
  assert.equal(inCheck(position), false);
  const result = analyze(position, { timeMs: 1000 });
  assert.equal(result.status, 'stalemate');
  assert.equal(result.score, 0);
  assert.equal(result.bestAction, null);
  assert.equal(result.completed, true);
});

test('zero budget remains incomplete and never invents a terminal result', () => {
  const mate = createPosition({ pgn: '1. e3 / f6 2. Qe2 / Nc6 3. Qh5' });
  const result = analyze(mate, { timeMs: 1000, maxNodes: 0 });
  assert.equal(result.nodes, 0);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completed, false);
  assert.equal(result.score, null);
  assert.equal(result.bestAction, null);
  assert.equal(result.stoppedReason, 'nodes');
});

test('a tiny deterministic budget retains a validated fallback without a fabricated score', () => {
  const position = createPosition();
  const options = { timeMs: 10000, maxNodes: 3, maxDepth: 8 };
  const first = analyze(position, options), second = analyze(position, options);
  assert.equal(first.nodes, 3);
  assert.equal(first.status, 'incomplete');
  assert.equal(first.score, null);
  assert.deepEqual(first.bestAction, second.bestAction);
  assert.equal(validateAction(position, first.bestAction).action, 1);
});

test('cooperative cancellation preserves the last completed iteration and its reported horizon', () => {
  const position = createPosition();
  let stopped = false, completedIteration;
  const result = analyze(position, {
    timeMs: 5000, maxDepth: 8, quiescenceDepth: 2,
    shouldStop: () => stopped,
    onProgress(progress) { completedIteration = progress; stopped = true; },
  });
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.completed, true);
  assert.equal(result.depth, 1);
  assert.equal(result.effectiveQuiescenceDepth, 0);
  assert.deepEqual(result.bestAction, completedIteration.bestAction);
  assert.equal(result.score, completedIteration.score);
  validatePv(position, result);
});

test('multiple active boards produce a full legal action, not one individual move', () => {
  const position = createPosition({ variant: 'two_timelines' });
  const result = analyze(position, { timeMs: 5000, maxDepth: 1, maxNodes: 100000, quiescenceDepth: 0 });
  assert.equal(result.depth, 1);
  assert(result.bestAction.length >= 2);
  assert.equal(validateAction(position, result.bestAction).action, 1);
  validatePv(position, result);
});

test('frontier material is not multiplied by historical copies or identical parallel boards', () => {
  const position = capturePosition();
  const history = { ...position, board: [[position.board[0][0], structuredClone(position.board[0][0]), structuredClone(position.board[0][0])]] };
  const parallel = { ...position, board: [position.board[0], null, structuredClone(position.board[0])] };
  assert.equal(evaluateDetailed(position).material, evaluateDetailed(history).material);
  assert.equal(evaluateDetailed(position).material, evaluateDetailed(parallel).material);
  assert.equal(evaluate(createPosition()), 0);
});

test('table bounds preserve a tactical result with the transposition table disabled', () => {
  const position = capturePosition();
  const options = { timeMs: 5000, maxDepth: 3, quiescenceDepth: 1, maxNodes: 100000 };
  const cached = analyze(position, options);
  const plain = analyze(position, { ...options, maxTableEntries: 0 });
  assert.equal(cached.depth, 3);
  assert.equal(plain.depth, 3);
  assert.equal(cached.score, plain.score);
  assert.deepEqual(cached.bestAction, plain.bestAction);
});

test('wall-clock cancellation returns promptly with a legal fallback', () => {
  const position = createPosition({ variant: 'two_timelines' });
  const before = performance.now();
  const result = analyze(position, { timeMs: 30, maxDepth: 16 });
  assert(performance.now() - before < 1000);
  assert.equal(result.stoppedReason, 'time');
  assert(result.bestAction);
  validateAction(position, result.bestAction);
});

test('locked-king puzzle completes depth three within a bounded work budget', () => {
  const position = createPosition({ pgn: '[Board "Custom"]\n[k7/pn6/K7/8/8/8/6PB/8:0:1:w]' });
  const original = positionKey(position);
  const result = analyze(position, { timeMs: 5000, maxDepth: 3, maxNodes: 20000, quiescenceDepth: 2 });
  assert.equal(result.depth, 3);
  assert.equal(result.effectiveQuiescenceDepth, 2);
  assert.equal(result.stoppedReason, 'depth');
  assert.equal(result.completed, true);
  assert(result.nodes < 20000);
  assert.match(formatAction(position, result.bestAction), /Bg1/);
  assert(result.selectiveDepth >= result.depth);
  assert.equal(positionKey(position), original);
  validatePv(position, result);
});
