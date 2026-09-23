import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDetailed } from '../src/evaluate.js';
import { createPosition, parseMove, raw, validateAction } from '../src/rules.js';
import { analyze } from '../src/search.js';

const empty = (height = 8, width = height) => Array.from({ length: height }, () => Array(width).fill(0));
const safety = position => evaluateDetailed(position).kingSafety;
const attacks = (board, source, target) => raw.pieceFuncs.moves(board, source).some(move =>
  target.every((coordinate, index) => move[1][index] === coordinate));

function reflect(position, { color = false, files = false } = {}) {
  return {
    ...position,
    action: position.action + Number(color),
    board: position.board.map(line => line?.map(snapshot => {
      if (!snapshot) return snapshot;
      const rows = color ? snapshot.toReversed() : snapshot;
      return rows.map(row => (files ? row.toReversed() : row).map(piece => {
        if (!color || !piece) return piece;
        const magnitude = Math.abs(piece);
        return Math.sign(piece) * (magnitude + (magnitude % 2 ? 1 : -1));
      }));
    })),
  };
}

const openingChoices = [
  { pgn: '', protectedMove: 'Nf3', alternative: 'Nc3' },
  // Both d-pawn pushes vacate the spatial shield; d4 additionally seals the
  // diagonal through e3 back onto f2, isolating its temporal benefit.
  { pgn: '1. Nf3 / Nf6', protectedMove: 'd4', alternative: 'd3' },
  { pgn: '1. Nf3 / Nf6 2. d4 / d5', protectedMove: 'c3', alternative: 'c4' },
];

for (const { pgn, protectedMove, alternative } of openingChoices) {
  test(`king safety rewards ${protectedMove} over ${alternative} for closing early temporal corridors`, () => {
    const position = createPosition({ pgn });
    const protectedPosition = validateAction(position, [protectedMove]);
    const alternativePosition = validateAction(position, [alternative]);
    assert(safety(protectedPosition) > safety(alternativePosition),
      `${protectedMove} should protect the king zone better than ${alternative}`);
    // The geometry should follow the royal's location and side, including
    // nonstandard reflected setups, rather than recognize opening notation.
    for (const color of [false, true]) for (const files of [false, true]) {
      const sign = color ? -1 : 1;
      assert(sign * safety(reflect(protectedPosition, { color, files })) >
        sign * safety(reflect(alternativePosition, { color, files })),
      `${protectedMove}/${alternative}, colors reflected=${color}, files reflected=${files}`);
    }
  });
}

test('opening protection evaluation preserves shared historical boards', () => {
  const position = createPosition({ pgn: '1. Nf3 / Nf6 2. d4 / d5' });
  const c3 = validateAction(position, ['c3']);
  const c4 = validateAction(position, ['c4']);
  const original = JSON.stringify([position, c3, c4]);
  const freeze = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(position); freeze(c3); freeze(c4);
  assert(safety(c3) > safety(c4));
  evaluateDetailed(position);
  assert.equal(JSON.stringify([position, c3, c4]), original);
  assert.equal(c3.board[0][0], position.board[0][0]);
  assert.equal(c4.board[0][0], position.board[0][0]);
});

test('upstream temporal queen geometry explains the Nf3, d4 and c3 barriers', () => {
  const cases = [
    { name: 'Nf3', source: [0, 4, 3, 5], target: [0, 0, 1, 5], blocker: [0, 2, 2, 5], piece: 6, targetPiece: 2 },
    { name: 'd4', source: [0, 6, 4, 2], target: [0, 0, 1, 5], blocker: [0, 4, 3, 3], piece: 2, targetPiece: 2 },
    { name: 'c3', source: [0, 7, 3, 1], target: [0, 1, 0, 4], blocker: [0, 5, 2, 2], piece: 2, targetPiece: 12 },
  ];
  for (const { name, source, target, blocker, piece, targetPiece } of cases) {
    const timeline = [];
    for (let t = target[1]; t <= source[1]; t += 2) timeline[t] = empty();
    const board = [timeline];
    timeline[source[1]][source[2]][source[3]] = 9;
    timeline[target[1]][target[2]][target[3]] = targetPiece;
    assert(attacks(board, source, target), `${name}: unobstructed ray reaches its historical target`);
    timeline[blocker[1]][blocker[2]][blocker[3]] = piece;
    assert.equal(attacks(board, source, target), false, `${name}: the developed piece closes the ray`);
    timeline[blocker[1]][blocker[2]][blocker[3]] = 0;
    // The same square on the other half-turn cannot obstruct this ray.
    timeline[blocker[1] - 1] = empty();
    timeline[blocker[1] - 1][blocker[2]][blocker[3]] = piece;
    assert(attacks(board, source, target), `${name}: half-turn parity is respected`);
  }
});

test('early king-zone corridors remain relevant after the king and blocker move away', () => {
  // Also cover a timeline beginning at t4 whose first odd snapshot is t5.
  // Its original odd king zone must survive beyond the recent-history window.
  for (const [first, anchor] of [[0, 0], [4, 5]]) {
    const latest = anchor + 16, timeline = [];
    for (let t = first; t <= latest; t++) {
      const snapshot = empty();
      snapshot[0][0] = 12;
      snapshot[7][7] = 11;
      snapshot[6][7] = 9;
      timeline[t] = snapshot;
    }
    timeline[anchor][0][0] = 0;
    timeline[anchor][0][4] = 12;
    timeline[anchor][1][5] = 2;
    const exposed = { board: [timeline], action: latest % 2 };
    const protectedPosition = structuredClone(exposed);
    protectedPosition.board[0][anchor + 2][2][5] = 6;
    assert.deepEqual(protectedPosition.board[0][latest], exposed.board[0][latest]);
    assert(safety(protectedPosition) > safety(exposed), `original king zone at t${anchor}`);
    assert.equal(evaluateDetailed(protectedPosition).material, evaluateDetailed(exposed).material);

    // Validate the old seal against an attacker on the corridor's launch
    // square, without requiring a current capture or adding it to evaluation.
    const source = [0, anchor + 4, 3, 5], target = [0, anchor, 1, 5];
    for (const [position, expected] of [[exposed, true], [protectedPosition, false]]) {
      const hypothetical = structuredClone(position.board);
      hypothetical[0][source[1]][source[2]][source[3]] = 9;
      assert.equal(attacks(hypothetical, source, target), expected);
    }
  }
});

test('an enemy already on an historical corridor is dangerous, not a protective seal', () => {
  const timeline = Array.from({ length: 17 }, () => {
    const snapshot = empty();
    snapshot[0][0] = 12;
    snapshot[7][7] = 11;
    snapshot[6][7] = 9;
    return snapshot;
  });
  timeline[0][0][0] = 0;
  timeline[0][0][4] = 12;
  timeline[0][1][5] = 2;
  const open = { board: [timeline], action: 0 };
  const occupied = piece => {
    const position = structuredClone(open);
    position.board[0][2][2][5] = piece;
    return position;
  };
  const enemy = occupied(9), friendly = occupied(6);
  assert(attacks(enemy.board, [0, 2, 2, 5], [0, 0, 1, 5]));
  assert(safety(enemy) <= safety(open));
  assert(safety(friendly) > safety(enemy));
  for (const position of [enemy, friendly]) {
    assert.deepEqual(position.board[0][16], open.board[0][16]);
    assert.equal(evaluateDetailed(position).material, evaluateDetailed(open).material);
  }
});

test('repeated historical king-zone targets do not accumulate an unbounded penalty', () => {
  const history = copies => {
    const timeline = Array.from({ length: copies * 2 + 1 }, () => {
      const snapshot = empty();
      snapshot[0][4] = 12;
      snapshot[1][5] = 2;
      snapshot[7][7] = 11;
      return snapshot;
    });
    timeline.at(-1)[3][5] = 9;
    return { board: [timeline], action: 0 };
  };
  assert.equal(safety(history(8)), safety(history(64)));
});

test('king-zone evaluation handles board edges, custom dimensions and sparse history', () => {
  for (const [height, width] of [[1, 2], [2, 1], [4, 4], [5, 7], [16, 16]]) {
    const snapshot = empty(height, width);
    snapshot[0][0] = 12;
    snapshot[height - 1][width - 1] = 11;
    const position = { board: [[snapshot, null, structuredClone(snapshot)]], action: 0 };
    const original = JSON.stringify(position);
    for (const value of Object.values(evaluateDetailed(position))) assert(Number.isFinite(value));
    assert.equal(JSON.stringify(position), original);
  }
  assert.equal(evaluateDetailed({ board: [], action: 0 }).total, 0);
});

test('search finds the protective d4 development after the knights reach f3 and f6', () => {
  const position = createPosition({ pgn: '1. Nf3 / Nf6' });
  const result = analyze(position, { maxDepth: 3, quiescenceDepth: 2, maxNodes: 25000, timeMs: 60000 });
  assert.equal(result.depth, 3);
  assert.equal(result.stoppedReason, 'depth');
  assert.equal(result.effectiveQuiescenceDepth, 2);
  assert.deepEqual(result.bestAction, [parseMove(position, 'd4')]);
  validateAction(position, result.bestAction);
});
