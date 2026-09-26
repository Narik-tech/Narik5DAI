import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentPolicyTargets } from '../src/transformer-policy.js';
import { generateTrainingData } from '../scripts/transformer-data.js';
import { applyMove, createPosition, generateActions, parseMove, pseudoMoves, raw, validateAction } from '../src/rules.js';

test('teacher policy labels replay legal components at each prefix', () => {
  const position = createPosition({variant:'two_timelines'});
  const action = generateActions(position).next().value.moves;
  const labels = componentPolicyTargets(position, action);
  assert(labels.length >= 2);
  let prefix = position;
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    assert.deepEqual(label.position ?? position, prefix);
    assert.deepEqual(label.moves[label.target], action[index]);
    assert(pseudoMoves(prefix).some(move => raw.validateFuncs.compareMove(move, label.moves[label.target]) === 0));
    prefix = applyMove(prefix, action[index]);
  }
  validateAction(position, action);
});

test('optional candidate mask retains temporal moves and excludes same-board moves', () => {
  const board = [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
  const position = {board:[[board], null, [structuredClone(board), structuredClone(board), structuredClone(board)]], action:0};
  const action = [parseMove(position, [[0, 0, 0, 0], [0, 0, 0, 1]])];
  validateAction(position, action);
  const [label] = componentPolicyTargets(position, action);
  assert(pseudoMoves(position).some(([from, to]) => from[0] === 2 && to[0] === 2 && from[1] === to[1]));
  assert(label.moves.every(([from, to]) => from[0] === 0 || from[0] !== to[0] || from[1] !== to[1]));
  assert(label.moves.some(([from, to]) => from[0] === 2 && (to[0] !== from[0] || to[1] !== from[1])));
});

test('policy labels reject an incomplete turn and gracefully omit terminal actions', () => {
  const position = createPosition({variant:'two_timelines'});
  assert.deepEqual(componentPolicyTargets(position, null), []);
  assert.throws(() => componentPolicyTargets(position, [pseudoMoves(position)[0]]));
});

test('teacher data labels completed search decisions, never an interrupted initial guess', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'transformer-policy-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [nodes, completed] of [[50, false], [1000, true]]) {
    const output = join(directory, nodes + '.jsonl');
    await generateTrainingData({ output, samples: 1, nodes, timeMs: 10000 });
    const record = JSON.parse((await readFile(output, 'utf8')).trim());
    assert.equal(record.teacher.completed, completed);
    assert.equal(Boolean(record.policy?.length), completed);
    if (completed) assert(record.policy.every(label => label.target >= 0 && label.target < label.moves.length));
  }
});
