import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDetailed } from '../src/evaluate.js';
import { raw } from '../src/rules.js';

const empty = () => Array.from({ length: 8 }, () => Array(8).fill(0));
function fixture(piece, source, target, intermediate = []) {
  const board = [];
  for (const [l, t] of [source, target, ...intermediate]) {
    board[l] ??= [];
    board[l][t] ??= empty();
  }
  board[source[0]][source[1]][source[2]][source[3]] = piece;
  board[source[0]][source[1]][7][0] = 12;
  board[target[0]][target[1]][target[2]][target[3]] = 11;
  return { board, action: source[1] % 2, promotions: [10, 9, 8, 7, 6, 5, 4, 3] };
}
function attacks(position, source, target) {
  return raw.pieceFuncs.moves(position.board, source).some(move =>
    target.every((value, index) => move[1][index] === value));
}

test('temporal slider pressure stops at historical blockers and missing boards', () => {
  const source = [0, 4, 1, 1], target = [0, 0, 1, 1];
  const clear = fixture(8, source, target, [[0, 2]]);
  assert(attacks(clear, source, target));
  assert(evaluateDetailed(clear).temporal > 0);

  for (const blocker of [2, 1, 12, 11, null]) {
    const blocked = structuredClone(clear);
    if (blocker === null) blocked.board[0][2] = null;
    else blocked.board[0][2][1][1] = blocker;
    assert.equal(attacks(blocked, source, target), false);
    // An enemy king is itself an earlier target; all other blockers prevent
    // pressure rather than contributing material from an historical board.
    if (blocker !== 11) assert.equal(evaluateDetailed(blocked).temporal, 0);
    assert.equal(evaluateDetailed(blocked).material, evaluateDetailed(clear).material);
  }
});

test('temporal knight attacks jump across missing intermediate history', () => {
  const source = [0, 4, 1, 1], target = [0, 0, 1, 2];
  const position = fixture(6, source, target);
  assert(attacks(position, source, target));
  assert(evaluateDetailed(position).temporal > 0);
});

test('pressure follows royal queen, common king, unicorn and dragon movement', () => {
  const cases = [
    [20, [0, 4, 1, 1], [0, 0, 1, 1], [[0, 2]]],
    [18, [0, 2, 1, 1], [0, 0, 1, 1]],
    [22, [0, 2, 1, 1], [2, 0, 2, 1]],
    [24, [0, 2, 1, 1], [2, 0, 2, 2]],
  ];
  for (const [piece, source, target, intermediate] of cases) {
    const position = fixture(piece, source, target, intermediate);
    assert(attacks(position, source, target), `Rules allow ${piece} to attack the target.`);
    assert(evaluateDetailed(position).temporal > 0, `Evaluation recognizes the ${piece} attack.`);
  }
  const distantKing = fixture(18, [0, 4, 1, 1], [0, 0, 1, 1], [[0, 2]]);
  assert.equal(evaluateDetailed(distantKing).temporal, 0);
});

test('even timelines remain adjacent across minus-zero and plus-zero', () => {
  const source = [1, 0, 1, 1], target = [2, 0, 1, 1];
  const position = fixture(8, source, target);
  assert.equal(raw.boardFuncs.isEvenTimeline(position.board), true);
  assert(attacks(position, source, target));
  assert(evaluateDetailed(position).temporal > 0);
  const oppositeHalfTurn = fixture(8, source, [2, 1, 1, 1]);
  assert.equal(attacks(oppositeHalfTurn, source, [2, 1, 1, 1]), false);
  assert.equal(evaluateDetailed(oppositeHalfTurn).temporal, 0);
});

test('temporal pressure and complete evaluation are color-symmetric without mutating history', () => {
  const position = fixture(8, [0, 4, 1, 1], [0, 0, 1, 1], [[0, 2]]);
  const original = JSON.stringify(position);
  const flipped = {
    ...position,
    board: position.board.map(line => line?.map(squares => squares?.toReversed().map(row => row.map(piece =>
      !piece ? 0 : Math.sign(piece) * (Math.abs(piece) % 2 ? Math.abs(piece) + 1 : Math.abs(piece) - 1))))),
  };
  const evaluation = evaluateDetailed(position), reverse = evaluateDetailed(flipped);
  for (const key of Object.keys(evaluation)) assert.equal(reverse[key] || 0, -evaluation[key] || 0, key);
  assert.equal(JSON.stringify(position), original);
});

test('pawn and brawn temporal pressure matches directional royal captures for both colors', () => {
  // Include normal and even timeline layouts, past/future pawn captures, all
  // brawn-only capture planes, backwards moves, and the wrong half-turn color.
  for (const piece of [1, 2, 15, 16]) {
    for (const sourceLine of [0, 1, 2]) {
      const source = [sourceLine, 4, 3, 3];
      for (const [targetLine, targetTime, rank, file] of [
        [0, 2, 3, 3], [1, 2, 3, 3], [2, 2, 3, 3], [3, 2, 3, 3],
        [0, 6, 3, 3], [1, 6, 3, 3], [2, 6, 3, 3], [3, 6, 3, 3],
        [0, 4, 3, 4], [1, 4, 3, 4], [2, 4, 3, 4], [3, 4, 3, 4],
        [0, 4, 4, 3], [1, 4, 4, 3], [2, 4, 4, 3], [3, 4, 4, 3],
        [0, 4, 2, 3], [1, 4, 2, 3], [2, 4, 2, 3], [3, 4, 2, 3],
        [sourceLine, 2, 4, 3], [sourceLine, 2, 2, 3],
        [sourceLine, 0, 4, 3], [sourceLine, 3, 4, 3],
      ]) {
        if (targetLine === sourceLine && targetTime >= 4) continue;
        const target = [targetLine, targetTime, rank, file];
        const position = fixture(piece, source, target);
        if (piece % 2) {
          position.board[sourceLine][4][7][0] = 11;
          position.board[targetLine][targetTime][rank][file] = 12;
        }
        const before = JSON.stringify(position);
        const expected = attacks(position, source, target);
        const pressure = evaluateDetailed(position).temporal;
        assert.equal(pressure !== 0, expected, `piece ${piece}: ${source} -> ${target}`);
        if (expected) assert.equal(Math.sign(pressure), piece % 2 ? -1 : 1);
        assert.equal(JSON.stringify(position), before);
      }
    }
  }
});

test('integer temporal geometry agrees with rules for leapers, rays, and off-ray targets', () => {
  const source = [0, 6, 3, 3];
  for (const piece of [4, 6, 8, 10, 12, 14, 18, 20, 22, 24]) {
    for (const line of [0, 1, 2, 3, 4, 5, 6]) {
      for (const time of [0, 2, 3, 4, 6]) {
        if (line === 0 && time === 6) continue;
        for (const [rank, file] of [[3, 3], [3, 4], [4, 4], [5, 3], [5, 4], [5, 5]]) {
          const target = [line, time, rank, file];
          const intermediate = [];
          for (let l = 0; l <= 6; l++) for (let t = 0; t <= (l === 0 ? 6 : 8); t += 2) intermediate.push([l, t]);
          const position = fixture(piece, source, target, intermediate);
          // A historical target cannot itself contribute counterpressure when
          // the attacker is royal. Even snapshots keep matching-color targets
          // in the evaluator's sample; wrong-parity targets must be ignored.
          const expected = attacks(position, source, target);
          assert.equal(evaluateDetailed(position).temporal > 0, expected, `piece ${piece}: ${source} -> ${target}`);
        }
      }
    }
  }
});
