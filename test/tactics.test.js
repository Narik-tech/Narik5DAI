import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/search.js';
import { applyMove, canSubmit, generateActions, inCheck, positionKey, validateAction } from '../src/rules.js';
import { assessTactic, loadTactics, runStrengthSuite } from '../scripts/strength.js';

const suite = await loadTactics();
for (const fixture of suite.cases) {
  test(`tactical corpus: ${fixture.title}`, () => {
    const before = positionKey(fixture.position);
    const result = analyze(fixture.position, { ...fixture.limits, timeMs: 30000 });
    const assessment = assessTactic(fixture, result, before);
    assert.equal(assessment.valid, true, assessment.errors.join(' '));
    assert.equal(assessment.solved, true, `${assessment.failures.join(' ')} ${JSON.stringify(result)}`);
    assert.equal(positionKey(fixture.position), before);
  });
}

test('the underpromotion fixture has exactly one mating turn, using a knight', () => {
  const fixture = suite.cases.find(item => item.id === 'knight-underpromotion');
  const mates = [];
  for (const candidate of generateActions(fixture.position, { pruneUnsafe: false, cacheMoves: false })) {
    const replies = generateActions(candidate.position, { pruneUnsafe: false, cacheMoves: false });
    const terminal = replies.next().done;
    replies.return();
    if (terminal && inCheck(candidate.position)) mates.push(candidate.moves);
  }
  assert.deepEqual(mates, [fixture.expected.action]);
});

test('the two-board tactical fixtures require both component moves before submission', () => {
  for (const id of ['dual-queens', 'dual-evasion']) {
    const fixture = suite.cases.find(item => item.id === id);
    const action = fixture.expected.action || fixture.expected.allowedActions[0];
    assert.equal(canSubmit(applyMove(fixture.position, action[0])), false);
    assert.equal(validateAction(fixture.position, action).action, fixture.position.action + 1);
    assert.throws(() => validateAction(fixture.position, [action[0]]), /cannot be submitted/);
  }
});

test('temporal mating capture branches without changing its historical queen square', () => {
  const fixture = suite.cases.find(item => item.id === 'temporal-knight-mate');
  const after = validateAction(fixture.position, fixture.expected.action);
  assert.equal(fixture.position.board[0][0][3][1], 9);
  assert.equal(after.board[0][0][3][1], 9);
  assert.equal(after.board[2][1][3][1], 6);
  assert(inCheck(after));
});

test('benchmark distinguishes tiny-budget legal fallbacks from solved tactics', async () => {
  const report = await runStrengthSuite({ budgets: [3], repeat: 2, caseIds: ['white-queen'], timeMs: 10000 });
  assert.equal(report.results[0].valid, true);
  assert.equal(report.results[0].solved, false);
  assert.equal(report.results[0].deterministic, true);
  assert.equal(report.results[0].nodes, 3);
  assert.equal(report.summary[0].solved, 0);
  assert.equal(report.results[0].score, null);
});

test('benchmark rejects malformed actions and does not call a shallow horizon solved', () => {
  const fixture = suite.cases.find(item => item.id === 'white-queen');
  const result = analyze(fixture.position, { timeMs: 10000, maxNodes: 10000, maxDepth: 1, quiescenceDepth: 0 });
  assert.deepEqual(result.bestAction, fixture.expected.action);
  assert.equal(assessTactic(fixture, result).solved, false);
  const broken = { ...result, bestAction: [[[0, 0, 0, 0], [0, 0, 3, 3]]] };
  assert.equal(assessTactic(fixture, broken).valid, false);
});

test('benchmark rejects a legal PV that violates the optional-board search policy', () => {
  const square = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
  const position = { board: [[square()], null, [square(), square(), square()]], action: 0, promotions: [10, 9, 8, 7, 6, 5, 4, 3] };
  const action = [[[0, 0, 0, 0], [0, 0, 0, 1]], [[2, 2, 0, 0], [2, 2, 0, 1]]];
  validateAction(position, action); // Allowed in manual play, excluded in search.
  const result = {
    bestAction: action, pv: [action], nodes: 0, searchNodes: 0, generationNodes: 0,
    limits: { maxNodes: 1000 }, status: 'ok', completed: true, searchPolicy: 'present-spatial',
  };
  const assessment = assessTactic({ position, expected: {} }, result);
  assert.equal(assessment.valid, false);
  assert.match(assessment.errors.join(' '), /ordinary move on an optional board/);
});
