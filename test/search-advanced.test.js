import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, MATE_SCORE } from '../src/search.js';
import { createPosition, formatAction, generateActions, inCheck, validateAction } from '../src/rules.js';

const promotions = [10, 9, 8, 7, 6, 5, 4, 3];
const limits = { timeMs: 10000, maxNodes: 200000 };

function validatePv(position, result) {
  let current = position;
  for (const action of result.pv) current = validateAction(current, action);
  return current;
}

test('shared quiet-move history completes opening depth four inside 24000 work nodes', () => {
  const position = createPosition();
  const result = analyze(position, { timeMs: 10000, maxDepth: 4, quiescenceDepth: 2, maxNodes: 24000 });
  assert.equal(result.depth, 4);
  assert.equal(result.effectiveQuiescenceDepth, 2);
  assert.equal(result.stoppedReason, 'depth');
  assert(result.nodes < 24000);
  validatePv(position, result);
});

test('checked-horizon evasions that deliver mate retain terminal scores', () => {
  // White has exactly two legal king moves. Each checks Black, whose queen
  // evasion then checkmates White. A static-only evasion horizon reports an
  // ordinary material loss and misses this forced mate at depth one.
  const position = {
    board: [[[[5, 0, 0, 0], [10, 12, 0, 9], [11, 0, 0, 0], [0, 0, 0, 0]]]],
    action: 0, promotions,
  };
  const legal = [...generateActions(position)];
  assert.equal(legal.length, 2);
  for (const action of legal) {
    assert(inCheck(action.position));
    const replies = [...generateActions(action.position)];
    assert(replies.some(reply => inCheck(reply.position) && [...generateActions(reply.position)].length === 0));
  }
  for (const maxTableEntries of [0, 1000]) {
    const result = analyze(position, { ...limits, maxDepth: 1, quiescenceDepth: 0, maxTableEntries });
    assert.equal(result.depth, 1);
    assert.equal(result.score, -MATE_SCORE + 2);
    assert.equal(result.scoreType, 'mate');
    assert.equal(result.mateIn, -2);
    assert.equal(result.pv.length, 2);
    const end = validatePv(position, result);
    assert(inCheck(end));
    assert.deepEqual([...generateActions(end)], []);
  }
});

test('quiescence warmup cache cannot replace a deeper recapture horizon', () => {
  const position = createPosition({ pgn: '1. e4 / e5 2. Nf3 / Nc6' });
  const common = { ...limits, maxDepth: 1, quiescenceDepth: 1 };
  const passes = [];
  const warmed = analyze(position, { ...common, onProgress: result => passes.push(result) });
  const fresh = analyze(position, { ...common, quiescenceWarmup: false });
  const uncached = analyze(position, { ...common, maxTableEntries: 0 });
  const quiet = passes.find(result => result.completed && result.effectiveQuiescenceDepth === 0);
  assert(quiet);
  assert.match(formatAction(position, quiet.bestAction), /Nxe5/);
  assert.doesNotMatch(formatAction(position, warmed.bestAction), /Nxe5/);
  assert(warmed.score < quiet.score);
  for (const result of [warmed, fresh, uncached]) {
    assert.equal(result.depth, 1);
    assert.equal(result.effectiveQuiescenceDepth, 1);
    assert.equal(result.score, warmed.score);
    assert.deepEqual(result.bestAction, warmed.bestAction);
    validatePv(position, result);
  }
});

test('quiescence bounds and small shared-table limits preserve the full search result', () => {
  const position = createPosition({ pgn: '[Board "Custom"]\n[k7/pn6/K7/8/8/8/6PB/8:0:1:w]' });
  const common = { ...limits, maxDepth: 2, quiescenceDepth: 2 };
  const reference = analyze(position, { ...common, maxTableEntries: 0 });
  assert.equal(reference.depth, 2);
  assert.equal(reference.tableEntries, 0);
  assert.equal(reference.ttHits, 0);
  assert.equal(reference.qTtHits, 0);
  for (const maxTableEntries of [1, 3, 100000]) {
    const result = analyze(position, { ...common, maxTableEntries });
    assert.equal(result.depth, 2);
    assert.equal(result.effectiveQuiescenceDepth, 2);
    assert.equal(result.score, reference.score);
    assert.deepEqual(result.bestAction, reference.bestAction);
    assert(result.tableEntries <= maxTableEntries);
    assert(result.qTtHits <= result.ttHits);
    validatePv(position, result);
    if (maxTableEntries === 100000) {
      assert(result.qTtHits > 0, 'the fixture must exercise cached tactical bounds');
      assert(result.nodes < reference.nodes, 'reusing tactical results should save search work');
    }
  }
});
