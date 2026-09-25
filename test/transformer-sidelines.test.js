import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseWork, rankDepths } from '../src/transformer-frontier.js';

function tree(rootSign = 1) {
  let nextIndex = 0;
  const root = { depth: 0, children: null, best: null };
  const levels = [[]];
  function add(parent, score, isTrue = true, extra = {}) {
    const value = score * rootSign;
    const node = {
      parent, depth: parent.depth + 1, index: nextIndex++,
      candidateScore: value, trueScore: isTrue ? value : null, value: isTrue ? value : null,
      children: null, best: null, terminal: null, mateProven: false, ...extra,
    };
    (parent.children ??= []).push(node);
    (levels[node.depth] ??= []).push(node);
    if (isTrue) parent.best ??= node;
    return node;
  }
  function chain(parent, length, score) {
    const nodes = [];
    for (let i = 0; i < length; i++) {
      parent = add(parent, score);
      nodes.push(parent);
    }
    return nodes;
  }
  return { root, levels, add, chain,
    rankings: () => rankDepths(levels, rootSign),
    choose: (maxDepth = 8) => chooseWork(rankDepths(levels, rootSign), { maxDepth }),
  };
}

test('a two-turn sideline gets priority over a five-turn leader for either root color', () => {
  for (const rootSign of [1, -1]) {
    const graph = tree(rootSign);
    const leader = graph.chain(graph.root, 5, 100);
    const sideline = graph.chain(graph.root, 2, 90);
    const rankings = graph.rankings();
    const order = rankings.map(level => level.ranked.slice());
    assert.deepEqual(chooseWork(rankings, { maxDepth: 8 }), { kind: 'expand', node: sideline[1] });
    assert.deepEqual(rankings.map(level => level.ranked), order,
      'exploration changes the chosen work without changing displayed evaluation ranks');
    assert.equal(rankings[0].ranked[0], leader[0]);
  }
});

test('an underexplored Candidate is evaluated before extending the leading True line', () => {
  const graph = tree();
  graph.chain(graph.root, 5, 100);
  const candidate = graph.add(graph.root, 90, false);
  assert.deepEqual(graph.choose(), { kind: 'evaluate', node: candidate });
});

test('exactly half the predecessor continuation length keeps normal scheduling', () => {
  const graph = tree();
  const leader = graph.chain(graph.root, 4, 100);
  graph.chain(graph.root, 2, 90);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: leader[3] });
});

test('later-depth comparisons count the complete root prefix as displayed', () => {
  const graph = tree();
  const parent = graph.add(graph.root, 100);
  const leader = graph.chain(parent, 3, 100);
  const sideline = graph.add(parent, 110);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: leader[2] },
    'depth-two lines of four and two turns are exactly half, despite their remaining lengths of three and one');
  const deeper = graph.add(leader[2], 100);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: sideline },
    'the same depth-two sideline takes priority once the preceding full continuation reaches five turns');
  assert.equal(deeper.depth, 5);
});

test('each entry compares with the immediately preceding rank rather than always with rank one', () => {
  const graph = tree();
  const leader = graph.chain(graph.root, 7, 100);
  graph.chain(graph.root, 6, 90);
  const third = graph.chain(graph.root, 3, 80);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: leader[6] },
    'three turns is half of rank two, although it is less than half of rank one');
  third[1].best = null;
  third[1].children = null;
  graph.levels[3] = graph.levels[3].filter(node => node !== third[2]);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: third[1] },
    'a two-turn rank-three line gets priority against its six-turn predecessor');
});

test('equally ranked deficits prefer the shallower entry', () => {
  const graph = tree();
  const leadingRoot = graph.add(graph.root, 100);
  graph.chain(leadingRoot, 5, 100);
  const shallowReply = graph.add(leadingRoot, 110);
  const sideline = graph.chain(graph.root, 2, 90);
  assert.equal(graph.rankings()[1].ranked[1], shallowReply);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: sideline[1] },
    'the rank-two root deficit precedes the rank-two depth-two deficit');
});

test('an exhausted first deficit allows the next eligible sideline to make progress', () => {
  const graph = tree();
  const leadingRoot = graph.add(graph.root, 100);
  graph.chain(leadingRoot, 5, 100);
  const shallowReply = graph.add(leadingRoot, 110);
  const sideline = graph.chain(graph.root, 2, 90);
  sideline[1].children = [];
  assert.deepEqual(graph.choose(), { kind: 'expand', node: shallowReply },
    'the closed root sideline does not prevent searching the depth-two deficit');
});

test('higher-ranked deficits take priority even when their entry is at a later depth', () => {
  const graph = tree();
  const leadingRoot = graph.add(graph.root, 100);
  graph.chain(leadingRoot, 5, 100);
  const shallowReply = graph.add(leadingRoot, 110);
  graph.chain(graph.root, 5, 90);
  graph.chain(graph.root, 2, 80);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: shallowReply },
    'rank two at depth two precedes an underexplored rank three at depth one');
});

test('priority persists through branch generation and evaluation, then ends once the line catches up', () => {
  const graph = tree();
  const leader = graph.chain(graph.root, 5, 100);
  const sideline = graph.add(graph.root, 90);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: sideline });
  const reply = graph.add(sideline, 90, false);
  assert.deepEqual(graph.choose(), { kind: 'evaluate', node: reply });
  reply.trueScore = reply.value = reply.candidateScore;
  sideline.best = reply;
  assert.deepEqual(graph.choose(), { kind: 'expand', node: reply });
  const continuation = graph.add(reply, 90, false);
  assert.deepEqual(graph.choose(), { kind: 'evaluate', node: continuation });
  continuation.trueScore = continuation.value = continuation.candidateScore;
  reply.best = continuation;
  assert.deepEqual(graph.choose(), { kind: 'expand', node: leader[4] },
    'three turns meets the five-turn predecessor threshold and restores ordinary priority');
});

test('the displayed best continuation determines a deficit, not the longest alternate descendant', () => {
  const graph = tree();
  graph.chain(graph.root, 5, 100);
  const sideline = graph.chain(graph.root, 2, 90);
  graph.chain(sideline[0], 5, 95);
  assert.deepEqual(graph.choose(), { kind: 'expand', node: sideline[1] },
    'a six-turn alternate reply does not conceal the selected two-turn continuation');
});

test('terminal and closed sidelines do not block available search work', () => {
  for (const closed of ['terminal', 'expanded']) {
    const graph = tree();
    const leader = graph.chain(graph.root, 5, 100);
    const sideline = graph.add(graph.root, 90);
    if (closed === 'terminal') sideline.terminal = { score: 0, mateProven: true };
    else sideline.children = [];
    assert.deepEqual(graph.choose(), { kind: 'expand', node: leader[4] }, closed);
  }
});

test('a proven or terminal best continuation does not force exploration of its alternatives', () => {
  for (const proven of [false, true]) {
    const graph = tree();
    const leader = graph.chain(graph.root, 5, 100);
    const sideline = graph.chain(graph.root, 2, -99_998);
    sideline[1].terminal = { score: -99_998, mateProven: true };
    sideline[1].mateProven = true;
    sideline[0].mateProven = proven;
    graph.add(sideline[0], 90, false);
    assert.deepEqual(graph.choose(), { kind: 'expand', node: leader[4] },
      'a resolved short best line is not a search deficit');
  }
});

test('sideline priority obeys the current depth ceiling while still evaluating leaves at that ceiling', () => {
  const graph = tree();
  graph.chain(graph.root, 5, 100);
  const sideline = graph.add(graph.root, 90);
  const reply = graph.add(sideline, 90, false);
  assert.deepEqual(graph.choose(2), { kind: 'evaluate', node: reply });
  reply.trueScore = reply.value = reply.candidateScore;
  sideline.best = reply;
  assert.equal(graph.choose(2), null, 'a short line at the ceiling must not expand past it');
  assert.deepEqual(graph.choose(3), { kind: 'expand', node: reply },
    'the sideline becomes eligible when the ceiling permits another turn');
});
