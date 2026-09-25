import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, MATE_SCORE } from '../src/transformer-search.js';
import { createPosition, generateActions, inCheck, parseMove, positionKey, validateAction } from '../src/rules.js';

function deferredMate() {
  // A partial Black turn reached from the locked-king position. Only +1 still
  // needs a component. Nd6 mates, but proving that requires exhausting many
  // optional White continuations on the other timelines.
  const position = createPosition({ pgn: `[Board "Custom"]
[k7/pn6/K7/8/8/8/6PB/8:0:1:w]
[k7/pn6/K7/8/8/6P1/7B/8:0:1:b]
[k7/p7/K7/2n5/8/6P1/7B/8:0:2:w]
[k7/p7/8/2n5/8/6P1/7B/8:0:2:b]
[k7/p7/8/8/8/6P1/7B/8:0:3:w]
[k7/pn6/K7/n7/8/6P1/7B/8:-1:2:w]
[k7/pn6/K7/1K6/8/8/6PB/8:+1:1:b]` });
  const action = [parseMove(position, '(1T1)Nd6')];
  const next = validateAction(position, action), key = positionKey(next);
  let shallowCalls = 0;
  const evaluateBatch = async positions => positions.map(item => {
    if (positionKey(item) !== key) return 700;
    shallowCalls++;
    return -700; // Make this candidate strongest for Black before its proof.
  });
  return { position, action, next, evaluateBatch, shallowCalls: () => shallowCalls };
}

const limits = { maxDepth: 1, candidateLimit: 1, maxNodes: 20000, timeMs: 10000 };

test('a selected candidate resumes an unknown shallow terminal probe and certifies its mate', async () => {
  const fixture = deferredMate();
  let work = 0;
  const replies = generateActions(fixture.next, { tick() { work++; } });
  try { assert.equal(replies.next().done, true); }
  finally { replies.return(); }
  assert(work > 1000, 'the proof must exceed the shallow component probe');
  assert.equal(inCheck(fixture.next), true);

  const result = await analyze(fixture.position, { ...limits, evaluateBatch: fixture.evaluateBatch });
  assert.equal(fixture.shallowCalls(), 1, 'the deferred candidate initially receives a model value');
  assert.deepEqual(result.bestAction, fixture.action);
  assert.equal(result.completed, true);
  assert.equal(result.trueEvaluations, 1);
  assert.equal(result.score, -MATE_SCORE + 1, 'the resumed proof must replace the shallow value');
  assert.equal(result.scoreType, 'mate');
  assert.equal(result.mateIn, -1);
  assert.equal(result.mateProven, true, 'unknown terminal status must not become a cached nonterminal');
  assert.deepEqual(result.pv, [fixture.action]);
});

test('interrupting a resumed terminal proof retains a legal heuristic fallback without a mate claim', async () => {
  const fixture = deferredMate();
  const result = await analyze(fixture.position, { ...limits, maxNodes: 1000, evaluateBatch: fixture.evaluateBatch });
  assert.equal(fixture.shallowCalls(), 1, 'candidate construction finishes before the proof is interrupted');
  assert.deepEqual(result.bestAction, fixture.action);
  assert.equal(positionKey(validateAction(fixture.position, result.bestAction)), positionKey(fixture.next));
  assert.equal(result.stoppedReason, 'nodes');
  assert.equal(result.completed, false);
  assert.equal(result.trueEvaluations, 0);
  assert.equal(result.depth, 0);
  assert.equal(result.score, -700);
  assert.equal(result.scoreType, 'cp');
  assert.equal(result.mateProven, false);
  assert.equal(result.mateIn, null);
  assert.equal(result.terminalProof, null);
});
