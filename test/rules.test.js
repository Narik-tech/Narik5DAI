import test from 'node:test';
import assert from 'node:assert/strict';
import {
  raw, createPosition, pseudoMoves, applyMove, canSubmit, submitPosition,
  inCheck, positionKey, formatMove, formatAction, parseMove, validateAction, generateActions,
  normalizePGN,
} from '../src/rules.js';

const smallBoard = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
const position = board => ({ board, action: 0, promotions: [10, 9, 8, 7, 6, 5, 4, 3] });

test('standard opening enumerates twenty complete legal turns', () => {
  const start = createPosition();
  assert.equal(pseudoMoves(start).length, 20);
  assert.equal(canSubmit(start), false);
  const actions = [...generateActions(start)];
  assert.equal(actions.length, 20);
  assert(actions.every(action => action.moves.length === 1 && action.position.action === 1));
  for (const action of actions) assert.deepEqual(validateAction(start, action.moves), action.position);
});

test('move application preserves history and shares immutable old boards', () => {
  const start = createPosition();
  const before = positionKey(start);
  const moved = applyMove(start, parseMove(start, 'e4'));
  assert.equal(positionKey(start), before);
  assert.notEqual(moved.board, start.board);
  assert.notEqual(moved.board[0], start.board[0]);
  assert.equal(moved.board[0][0], start.board[0][0]);
  assert.equal(moved.board[0][1][3][4], 2);
  assert.equal(moved.board[0][1][1][4], 0);
  assert.equal(submitPosition(moved).action, 1);
});

test('time travel branches without modifying its historical target', () => {
  const start = createPosition({ pgn: '1. Nf3 / Nf6 2. Nc3 / Nc6' });
  const move = parseMove(start, [[0, 4, 2, 2], [0, 2, 4, 2]]);
  const next = applyMove(start, move);
  assert.equal(next.board[2][3][4][2], 6);
  assert.equal(next.board[0][5][2][2], 0);
  assert.equal(start.board[0][2][4][2], 0);
  assert.equal(next.board[0][2], start.board[0][2]);
  assert.deepEqual(raw.boardFuncs.active(next.board), [0, 2]);
  assert.deepEqual(parseMove(start, formatMove(start, move)), move);
  assert.match(formatAction(start, [move]), /Nc3/);
});

test('temporary self-check is allowed inside a complete multiple-board turn', () => {
  const left = smallBoard(); left[3][0] = 7;
  const start = position([[left], null, [structuredClone(left)]]);
  const first = [[0, 0, 0, 0], [0, 0, 0, 1]];
  const second = [[2, 0, 0, 0], [2, 0, 0, 1]];
  const halfway = applyMove(start, parseMove(start, first));
  assert(inCheck(halfway));
  assert.equal(canSubmit(halfway), false);
  assert.equal(validateAction(start, [first, second]).action, 1);
  const target = positionKey(validateAction(start, [first, second]));
  assert([...generateActions(start)].some(action => positionKey(action.position) === target));
});

test('generator continues optional moves after a legal submission and deduplicates orderings', () => {
  const board = smallBoard();
  const start = position([[board], null, [structuredClone(board), structuredClone(board), structuredClone(board)]]);
  const actions = [...generateActions(start)];
  assert(actions.some(action => action.moves.length === 1));
  assert(actions.some(action => action.moves.length === 2));
  const keys = actions.map(action => positionKey(action.position));
  assert.equal(new Set(keys).size, keys.length);
  for (const action of actions) validateAction(start, action.moves);
});

test('inactive timelines remain eligible sources for optional moves', () => {
  const board = smallBoard();
  const start = position([[board], null, [structuredClone(board)], null, [structuredClone(board)]]);
  assert.equal(raw.boardFuncs.active(start.board).includes(4), false);
  assert(pseudoMoves(start).some(move => move[0][0] === 4));
});

test('a known temporal checkmate has no complete legal action', () => {
  const mate = createPosition({ pgn: '1. e3 / f6 2. Qe2 / Nc6 3. Qh5' });
  assert(inCheck(mate));
  assert.equal([...generateActions(mate)].length, 0);
});

test('royal captures are threats and cannot be played', () => {
  const board = smallBoard(); board[2][3] = 8;
  const start = position([[board]]);
  const capture = [[0, 0, 2, 3], [0, 0, 3, 3]];
  assert(raw.boardFuncs.moves(start.board, 0, false, false).some(move => JSON.stringify(move) === JSON.stringify(capture)));
  assert.throws(() => parseMove(start, capture), /Illegal/);
});

test('pawn forward timeline and temporal diagonal capture are distinct moves', () => {
  const destination = smallBoard();
  const future = smallBoard(); future[1][1] = 7;
  const source = smallBoard(); source[1][1] = 2;
  const start = position([[destination, structuredClone(destination), future], null, [source]]);
  const moves = pseudoMoves(start).filter(move => JSON.stringify(move[0]) === '[2,0,1,1]');
  assert(moves.some(move => JSON.stringify(move[1]) === '[0,0,1,1]'));
  assert(moves.some(move => JSON.stringify(move[1]) === '[0,2,1,1]'));
  assert.equal(moves.some(move => move[1][0] === 2 && move[1][1] !== 0), false);
});

test('en passant and promotion remain supported', () => {
  const ep = createPosition({ pgn: '1. e4 / a6 2. e5 / d5' });
  const capture = parseMove(ep, 'exd6');
  assert.equal(capture.length, 3);
  const after = validateAction(ep, [capture]);
  assert.equal(after.board[0].at(-1)[4][3], 0);
  assert.equal(after.board[0].at(-1)[5][3], 2);
  const board = smallBoard(); board[2][1] = 2;
  const promotion = position([[board]]);
  assert(pseudoMoves(promotion).some(move => move[1][2] === 3 && move[1][3] === 1 && move[1][4] === 10));
});

test('complete history, mover, and promotion set are all part of the state key', () => {
  const first = createPosition();
  const second = applyMove(first, parseMove(first, 'e4'));
  const changedPast = structuredClone(second);
  changedPast.board[0][0][1][0] = 0;
  assert.notEqual(positionKey(second), positionKey(changedPast));
  assert.notEqual(positionKey(second), positionKey({ ...second, action: 1 }));
  assert.notEqual(positionKey(second), positionKey({ ...second, promotions: [10, 9] }));
});

test('invalid imports are rejected and cancellation propagates without a mate claim', () => {
  assert.throws(() => createPosition({ pgn: '1. e5' }));
  assert.throws(() => createPosition({ pgn: 'this is not a chess game' }));
  let nodes = 0;
  assert.throws(() => [...generateActions(createPosition(), { tick() { if (++nodes === 5) throw new Error('cancelled'); } })], /cancelled/);
});

test('castling moves both pieces and forbids crossing an attacked square', () => {
  const fen = '[Board "Custom"]\n[Size "8x8"]\n[r*3k*2r*/8/8/8/8/8/8/R*3K*2R*:0:1:w]';
  const start = createPosition({ pgn: fen });
  const castle = parseMove(start, 'O-O');
  assert.equal(castle.length, 4);
  const next = validateAction(start, [castle]);
  assert.equal(next.board[0][1][0][6], 12);
  assert.equal(next.board[0][1][0][5], 8);
  assert.equal(next.board[0][1][0][4], 0);
  assert.equal(next.board[0][1][0][7], 0);
  const attacked = structuredClone(start);
  attacked.board[0][0][7][5] = 7;
  assert.throws(() => parseMove(attacked, 'O-O'));
});

test('queen and king travel on four axes; bishop, unicorn and dragon have exact axis counts', () => {
  const empty = () => Array.from({ length: 5 }, () => Array(5).fill(0));
  const source = [0, 2, 1, 1];
  for (const [piece, allowedAxes, leaper] of [[4, [2], false], [10, [1, 2, 3, 4], false], [12, [1, 2, 3, 4], true], [22, [3], false], [24, [4], false]]) {
    const board = [[empty(), empty(), empty()], null, [empty(), empty(), empty()]];
    board[0][2][1][1] = piece;
    const start = position(board);
    const moves = pseudoMoves(start).filter(move => JSON.stringify(move[0]) === JSON.stringify(source));
    const fourAxis = moves.some(move => JSON.stringify(move[1]) === '[2,0,2,2]');
    assert.equal(fourAxis, allowedAxes.includes(4), `piece ${piece} four-axis movement`);
    const directions = leaper ? raw.pieceFuncs.movePos(piece) : raw.pieceFuncs.moveVecs(piece);
    assert(directions.every(vector => allowedAxes.includes(vector.filter(Boolean).length)));
    if (piece === 10 || piece === 12) assert.equal(directions.length, 80);
    if (piece === 4) assert.equal(directions.length, 24);
    if (piece === 22) assert.equal(directions.length, 32);
    if (piece === 24) assert.equal(directions.length, 16);
  }
});

test('PGN normalization preserves a selected variant and rejects unfinished turns', () => {
  const defended = createPosition({ variant: 'defended_pawn', pgn: '1. e4' });
  assert.equal(Math.abs(defended.board[0][0][0][1]), 10);
  assert.equal(Math.abs(defended.board[0][0][0][3]), 6);
  const partial = '[Board "Custom"]\n[Size "4x4"]\n[3k/4/4/K3:0:1:w]\n[3k/4/4/K3:1:1:w]\n1. (0T1)Kb1';
  assert.throws(() => createPosition({ pgn: partial }), /incomplete/);
  assert.throws(() => createPosition({ pgn: '[Board "Custom"]' }), /royal/);
  assert.throws(() => createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[4/4/4/K3:0:1:w]' }), /royal/);
  assert.throws(() => createPosition({ pgn: '[Board "Invented"]' }), /Unknown/);
  assert.throws(() => createPosition({ variant: 'invented' }), /Unknown/);
});

test('import bounds reject expensive sparse allocations before the upstream parser runs', () => {
  assert.throws(() => normalizePGN('1. (1000000000T1)Ka1'), /coordinates/);
  assert.throws(() => normalizePGN('[8/8/8/8/8/8/8/8:0:1e9:w]'), /coordinates/);
  assert.throws(() => normalizePGN('[999999999/8/8/8/8/8/8/8:0:1:w]'), /empty-square/);
  assert.throws(() => normalizePGN('[Size "9999999x8"]'), /dimensions/);
  assert.throws(() => normalizePGN('[Mode "2D"]'), /5D/);
});
