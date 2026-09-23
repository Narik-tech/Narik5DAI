import test from 'node:test';
import assert from 'node:assert/strict';
import {
  raw, createPosition, canSubmit, inCheck, positionKey, pseudoMoves,
  parseMove, applyMove, validateAction,
} from '../src/rules.js';

const empty = () => Array.from({ length: 8 }, () => Array(8).fill(0));
const promotions = [10, 9, 8, 7, 6, 5, 4, 3];
function upstreamThreat(position) {
  return raw.boardFuncs.moves(position.board, position.action + 1, false, false, false, position.promotions).some(move => {
    const [l, t, r, f] = move[1], piece = Math.abs(position.board[l]?.[t]?.[r]?.[f]);
    return [11, 12, 19, 20].includes(piece) && piece % 2 === position.action % 2;
  });
}
function equivalent(position) {
  const before = positionKey(position);
  const expectedSubmit = raw.boardFuncs.present(position.board, position.action).length === 0 && !upstreamThreat(position);
  assert.equal(canSubmit(position), expectedSubmit);
  const board = position.board.map(line => line?.slice() ?? line);
  raw.mateFuncs.blankAction(board, position.action);
  assert.equal(inCheck(position), upstreamThreat({ ...position, board }));
  assert.equal(positionKey(position), before);
}
function fixture(piece, source, target, royalPiece = 12) {
  const board = [];
  for (const [l, t] of [source, target]) {
    board[l] ??= [];
    for (let past = 0; past <= t; past++) board[l][past] ??= empty();
  }
  board[source[0]][source[1]][source[2]][source[3]] = piece;
  board[source[0]][source[1]][7][7] = 11;
  board[target[0]][target[1]][target[2]][target[3]] = royalPiece;
  return { board, action: 0, promotions };
}

test('early royal detection agrees with full enumeration for every piece and either royal type', () => {
  const cases = [
    [1, [0, 1, 2, 1], [0, 1, 1, 2]],
    [3, [0, 3, 2, 2], [2, 1, 2, 2]],
    [5, [0, 5, 2, 2], [0, 1, 3, 2]],
    [7, [0, 5, 2, 2], [0, 1, 2, 2]],
    [9, [0, 3, 2, 2], [2, 1, 3, 3]],
    [11, [0, 3, 2, 2], [2, 1, 3, 3]],
    [13, [0, 3, 2, 2], [2, 1, 2, 2]],
    [15, [0, 1, 2, 2], [2, 1, 1, 2]],
    [17, [0, 3, 2, 2], [2, 1, 3, 3]],
    [19, [0, 3, 2, 2], [2, 1, 3, 3]],
    [21, [0, 3, 2, 2], [2, 1, 3, 2]],
    [23, [0, 3, 2, 2], [2, 1, 3, 3]],
  ];
  for (const [piece, source, target] of cases) for (const royalPiece of [12, 20]) {
    const position = fixture(piece, source, target, royalPiece);
    assert(upstreamThreat(position), `piece ${piece} attacks royal ${royalPiece}`);
    assert.equal(canSubmit(position), false);
    equivalent(position);
    const safe = structuredClone(position);
    safe.board[target[0]][target[1]][target[2]][target[3]] = 0;
    assert.equal(upstreamThreat(safe), false);
    equivalent(safe);
  }
});

test('inactive and even timelines are included, while historical pieces cannot be attack sources', () => {
  const inactive = fixture(7, [4, 1, 2, 2], [4, 1, 2, 5]);
  inactive.board[0] = [empty(), empty()];
  inactive.board[2] = [empty(), empty()];
  assert.equal(raw.boardFuncs.active(inactive.board).includes(4), false);
  assert(upstreamThreat(inactive));
  equivalent(inactive);

  const even = fixture(7, [1, 1, 2, 2], [2, 1, 2, 2]);
  assert.equal(raw.boardFuncs.isEvenTimeline(even.board), true);
  assert(upstreamThreat(even));
  equivalent(even);

  const historical = fixture(7, [0, 1, 2, 2], [0, 1, 2, 5]);
  historical.board[0].push(empty(), empty());
  assert.equal(upstreamThreat(historical), false);
  equivalent(historical);
  const wrongParity = fixture(7, [0, 1, 2, 2], [0, 1, 2, 5]);
  wrongParity.board[0].push(structuredClone(wrongParity.board[0][1]));
  assert.equal(upstreamThreat(wrongParity), false);
  equivalent(wrongParity);
});

test('phantom passing and partial multiboard turns match full threat enumeration', () => {
  const first = empty(); first[0][0] = 12; first[7][0] = 7; first[7][7] = 11;
  const position = { board: [[first], null, [structuredClone(first)]], action: 0, promotions };
  assert.equal(upstreamThreat(position), false);
  assert.equal(inCheck(position), true);
  equivalent(position);
  const partial = applyMove(position, parseMove(position, [[0, 0, 0, 0], [0, 0, 0, 1]]));
  assert.equal(inCheck(partial), true);
  equivalent(partial);
  const completed = applyMove(partial, parseMove(partial, [[2, 0, 0, 0], [2, 0, 0, 1]]));
  assert.equal(canSubmit(completed), true);
  equivalent(completed);
});

test('en passant, castling, promotions and real temporal histories preserve threat results', () => {
  const ep = createPosition({ pgn: '1. e4 / a6 2. e5 / d5' });
  const castle = createPosition({ pgn: '[Board "Custom"]\n[r*3k*2r*/8/8/8/8/8/8/R*3K*2R*:0:1:w]' });
  const promotion = createPosition({ pgn: '[Board "Custom"]\n[Promotions "Q,R,B,N"]\n[7k/1P6/8/8/8/8/8/K7:0:1:w]' });
  const temporal = createPosition({ pgn: '1. Nf3 / Nf6 2. Nc3 / Nc6' });
  assert.equal(parseMove(ep, 'exd6').length, 3);
  assert.equal(parseMove(castle, 'O-O').length, 4);
  assert(pseudoMoves(promotion).some(move => move[1].length > 4));
  for (const start of [ep, castle, promotion, temporal]) {
    equivalent(start);
    // Check both the partial action (submission safety) and the next player's
    // forced-pass view, including candidates rejected by royal safety.
    for (const move of pseudoMoves(start)) {
      const next = applyMove(start, move);
      equivalent(next);
      equivalent({ ...next, action: next.action + 1 });
    }
  }
  const branched = validateAction(temporal, [parseMove(temporal, '(0T3)Nc3>>(0T2)c5')]);
  equivalent(branched);
  assert(branched.board.filter(Boolean).length > 1);
});
