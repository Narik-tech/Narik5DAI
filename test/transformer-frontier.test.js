import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseWork, rankDepths } from '../src/transformer-frontier.js';

const node = (depth, index, candidateScore, trueScore = null, extra = {}) => ({
  depth, index, candidateScore, trueScore, value: trueScore,
  children: null, terminal: null, ...extra,
});
const ranked = (levels, rootSign = 1) => rankDepths(levels, rootSign);
const choose = (levels, options = {}) => chooseWork(ranked(levels), { maxDepth: 8, ...options });

test('depth rankings alternate the mover perspective and use backed True values', () => {
  const first = [node(1, 0, 10), node(1, 1, 90), node(1, 2, 1000, 50, { value: 70 })];
  const second = [node(2, 3, 10), node(2, 4, 90), node(2, 5, -1000, 50, { value: 70 })];
  const white = ranked([[], first, second]);
  assert.deepEqual(white.map(row => row.depth), [1, 2]);
  assert.deepEqual(white[0].ranked, [first[1], first[2], first[0]]);
  assert.deepEqual(white[1].ranked, [second[0], second[2], second[1]]);
  const black = ranked([[], first, second], -1);
  assert.deepEqual(black[0].ranked, [first[0], first[2], first[1]]);
  assert.deepEqual(black[1].ranked, [second[1], second[2], second[0]]);
});

test('equal values retain deterministic insertion order without mutating level arrays', () => {
  const first = node(1, 0, 10), second = node(1, 1, 10, 10), third = node(1, 2, 10);
  const level = [third, first, second];
  assert.deepEqual(ranked([[], level])[0].ranked, [first, second, third]);
  assert.deepEqual(level, [third, first, second]);
});

test('Searched Moves counts only the True prefix and changes when scores are backed up', () => {
  const strongest = node(1, 0, 90, 90);
  const candidate = node(1, 1, 80);
  const weakerTrue = node(1, 2, 70, 70);
  const weakestCandidate = node(1, 3, 10);
  const levels = [[], [strongest, candidate, weakerTrue, weakestCandidate]];
  let row = ranked(levels)[0];
  assert.equal(row.searchedMoves, 1, 'a True evaluation after the first candidate is not counted');
  assert.equal(row.candidate, candidate);
  strongest.value = 50;
  row = ranked(levels)[0];
  assert.equal(row.searchedMoves, 0, 'a backed value can move the former leader below a candidate');
  assert.equal(row.candidate, candidate);
  candidate.trueScore = 60;
  candidate.value = 60;
  row = ranked(levels)[0];
  assert.equal(row.searchedMoves, 3);
  assert.equal(row.candidate, weakestCandidate);
});

test('candidate evaluation chooses the least-searched depth and then the shallower tie', () => {
  const rootTrue = node(1, 0, 100, 100), rootCandidate = node(1, 1, 50);
  const replyCandidate = node(2, 2, -100), otherReply = node(2, 3, -50);
  const deeperCandidate = node(3, 4, 100);
  const levels = [[], [rootTrue, rootCandidate], [otherReply, replyCandidate], [deeperCandidate]];
  assert.deepEqual(choose(levels), { kind: 'evaluate', node: replyCandidate });
  replyCandidate.trueScore = -100;
  replyCandidate.value = -100;
  assert.deepEqual(choose(levels), { kind: 'evaluate', node: deeperCandidate });
});

test('a single True leader can expand immediately with a common prefix of one', () => {
  const first = node(1, 0, 100, 100), second = node(1, 1, 90);
  const levels = [[], [first, second]];
  assert.deepEqual(choose(levels), { kind: 'expand', node: first });
  first.children = [];
  assert.deepEqual(choose(levels), { kind: 'evaluate', node: second });
});

test('the common prefix grows dynamically and permits the matching one-based rank', () => {
  const first = node(1, 0, 100, 100, { children: [] });
  const second = node(1, 1, 90, 90), third = node(1, 2, 80);
  const replyFirst = node(2, 3, -100, -100, { children: [] });
  const replySecond = node(2, 4, -90), replyThird = node(2, 5, -80);
  const levels = [[], [first, second, third], [replyFirst, replySecond, replyThird]];
  assert.deepEqual(choose(levels), { kind: 'evaluate', node: replySecond },
    'rank two waits while another depth only has a one-entry True prefix');
  replySecond.trueScore = -90;
  replySecond.value = -90;
  assert.deepEqual(choose(levels), { kind: 'expand', node: second },
    'two True leaders at every pending depth permit rank two, with a shallower tie');
});

test('an under-searched deeper frontier delays expansion of shallower True evaluations', () => {
  const first = node(1, 0, 100, 100), second = node(1, 1, 90, 90), third = node(1, 2, 80, 80);
  const shallowCandidate = node(1, 3, 70), deepCandidate = node(2, 4, -50);
  assert.deepEqual(choose([[], [first, second, third, shallowCandidate], [deepCandidate]]),
    { kind: 'evaluate', node: deepCandidate });
});

test('expansion prioritizes one-based ranking before depth and uses shallower depth for ties', () => {
  const first = node(1, 0, 100, 100, { children: [] });
  const second = node(1, 1, 90, 90), third = node(1, 2, 80, 80);
  const deeperFirst = node(2, 3, -100, -100), deeperSecond = node(2, 4, -90, -90);
  const levels = [[], [first, second, third], [deeperFirst, deeperSecond]];
  assert.deepEqual(choose(levels), { kind: 'expand', node: deeperFirst });
  first.children = null;
  assert.deepEqual(choose(levels), { kind: 'expand', node: first });
});

test('exhausted short depths do not block deeper expansion', () => {
  const first = node(1, 0, 100, 100, { children: [] });
  const reply = node(2, 1, -10, -10);
  const levels = [[], [first], [reply]];
  assert(ranked(levels).every(row => row.searchedMoves === Infinity));
  assert.deepEqual(choose(levels), { kind: 'expand', node: reply });
});

test('only True, unexpanded, nonterminal nodes inside the common prefix can expand', () => {
  const terminal = node(1, 0, 100, 100, { terminal: { score: 100 } });
  const expanded = node(1, 1, 90, 90, { children: [] });
  const outsideRank = node(1, 2, 80, 80);
  const candidate = node(1, 3, 70, null, { value: 1000 });
  const replyFirst = node(2, 4, -100, -100, { terminal: { score: -100 } });
  const replySecond = node(2, 5, -90, -90, { children: [] });
  const replyCandidate = node(2, 6, -80);
  const levels = [[], [terminal, expanded, outsideRank, candidate], [replyFirst, replySecond, replyCandidate]];
  assert.deepEqual(choose(levels), { kind: 'evaluate', node: replyCandidate },
    'with no expansion inside the common prefix, pending candidates still make progress');
  outsideRank.children = [];
  replyCandidate.trueScore = -80;
  replyCandidate.value = -80;
  replyCandidate.children = [];
  assert.deepEqual(choose(levels), { kind: 'evaluate', node: candidate },
    'a candidate with an incidental value remains unevaluated');
  candidate.trueScore = 70;
  candidate.value = 70;
  candidate.children = [];
  assert.equal(choose(levels), null, 'closed frontiers finish once every candidate has been evaluated');
});

test('exhausted depths allow expansion beyond an earlier finite prefix', () => {
  const first = node(1, 0, 100, 100, { children: [] });
  const second = node(1, 1, 90, 90, { children: [] });
  const third = node(1, 2, 80, 80);
  const reply = node(2, 3, -10, -10, { children: [] });
  assert.deepEqual(choose([[], [first, second, third], [reply]]), { kind: 'expand', node: third },
    'a shorter exhausted depth has no remaining candidate that can block rank three');
});

test('max depth permits candidate evaluation but prevents another expansion', () => {
  const leaf = node(1, 0, 100, 100);
  assert.equal(choose([[], [leaf]], { maxDepth: 1 }), null);
  const candidate = node(1, 1, 90);
  assert.deepEqual(choose([[], [leaf, candidate]], { maxDepth: 1 }), { kind: 'evaluate', node: candidate });
});

test('empty frontiers finish without a work item', () => {
  assert.deepEqual(ranked([[], [], []]), []);
  assert.equal(choose([[], [], []]), null);
});
