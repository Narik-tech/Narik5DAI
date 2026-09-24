import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../src/session.js';
import {
  raw, createPosition, pseudoMoves, applyMove, canSubmit, submitPosition,
  inCheck, positionKey, formatMove, formatAction, parseMove, validateAction, generateActions, generateActionsAsync,
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

test('awaited component ordering preserves the synchronous legal action traversal', async () => {
  const checked = smallBoard(); checked[3][0] = 7;
  const first = smallBoard(); first[1][1] = 4;
  const positions = [
    createPosition(),
    position([[checked], null, [structuredClone(checked)]]),
    position([[first], null, [smallBoard(), smallBoard(), smallBoard()]]),
  ];
  for (const start of positions) {
    const before = positionKey(start);
    const reverse = (_current, moves) => moves.toReversed();
    const expected = [...generateActions(start, { orderMoves: reverse })];
    let calls = 0;
    const actual = [];
    for await (const candidate of generateActionsAsync(start, {
      orderMoves: async (current, moves) => {
        await Promise.resolve();
        calls++;
        assert.equal(current.action, start.action, 'partial turns retain the mover');
        return reverse(current, moves);
      },
    })) actual.push(candidate);
    assert(calls > 0);
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual.map(candidate => positionKey(candidate.position))).size, actual.length);
    for (const candidate of actual) assert.deepEqual(validateAction(start, candidate.moves), candidate.position);
    assert.equal(positionKey(start), before);
  }
});

test('async action generation preserves optional-first temporal branches and preferred turns', async () => {
  const first = smallBoard(); first[1][1] = 4;
  const start = position([[first], null, [smallBoard(), smallBoard(), smallBoard()]]);
  const advance = parseMove(start, [[2, 2, 0, 0], [2, 2, 0, 1]]);
  const travel = parseMove(start, [[0, 0, 1, 1], [2, 2, 1, 1]]);
  const preferredAction = [advance, travel];
  const expected = validateAction(start, preferredAction);
  const actions = [];
  for await (const candidate of generateActionsAsync(start, {
    preferredAction, orderMoves: async (_current, moves) => moves.toReversed(),
  })) actions.push(candidate);
  assert.deepEqual(actions[0].moves, preferredAction);
  assert.deepEqual(actions[0].position, expected);
  assert(expected.board[4], 'the optional spatial advance makes the arrival branch');
  const keys = candidates => candidates.map(candidate => positionKey(candidate.position)).sort();
  assert.deepEqual(keys(actions), keys([...generateActions(start)]));
  assert.equal(new Set(keys(actions)).size, actions.length);
});

test('async ordering failures and cancellation propagate without a terminal result', async () => {
  const collect = async options => {
    const result = [];
    for await (const candidate of generateActionsAsync(createPosition(), options)) result.push(candidate);
    return result;
  };
  await assert.rejects(collect({ orderMoves: async () => { throw new Error('inference failed'); } }), /inference failed/);
  let ticks = 0;
  await assert.rejects(collect({
    orderMoves: async (_current, moves) => moves,
    tick() { if (++ticks === 5) throw new Error('cancelled'); },
  }), /cancelled/);
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

test('missing custom setup rejects and bare FEN selects Custom instead of standard', () => {
  assert.throws(() => createPosition({ variant: 'custom' }), /require FEN/);
  assert.throws(() => createPosition({ variant: 'custom', pgn: '' }), /require FEN/);
  const game = new GameSession({ pgn: '[Size "4x4"]\n[3k/4/4/K3:0:1:w]' });
  assert.equal(game.position.board[0][0].length, 4);
  assert.equal(game.chess.metadata.board, 'custom');
  assert.equal(pseudoMoves(game.position).length, 3);
  assert.throws(() => createPosition({ pgn: '[Board "Standard"]\n[Size "4x4"]\n[3k/4/4/K3:0:1:w]' }), /Custom/);
});

test('Black custom frontier without timeline zero stays synchronized through play and export', () => {
  const game = new GameSession({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[3k/4/4/K3:1:1:b]' });
  assert.equal(game.position.action, 1);
  assert.equal(game.chess.rawStartingAction, 1);
  assert.equal(game.chess.player, 'black');
  const move = pseudoMoves(game.position)[0];
  game.play([move]);
  assert.equal(positionKey(createPosition({ pgn: game.chess.export() })), positionKey(game.position));
  assert.equal(game.chess.rawAction, game.position.action);
  const whiteAction = '[Board "Custom"]\n[Size "4x4"]\n[3k/4/4/K3:1:1:b]\n1. (+0T0)Kc4';
  assert.throws(() => createPosition({ pgn: whiteAction }), /player/);
});

test('discarded PGN text, duplicate critical headers, and move suffix junk are rejected', () => {
  for (const pgn of [
    '{}', '[not valid]', '1. e4oops', '50. e4',
    '[Board "Standard"]\n[Board "Bogus"]\n1. e4',
    '[Size "8x8"]\n[size "8x8"]',
    '[Mode "5D"]\n[mode "5D"]',
    '[Promotions "Q"]\n[Promotions "N"]',
    '1. e4 /', '1. e4 / / e5', '1. e4 1-0 unexpected',
  ]) assert.throws(() => createPosition({ pgn }), undefined, pgn);
  const game = new GameSession();
  const key = positionKey(game.position), revision = game.revision;
  for (const token of ['e4oops', 'e(>L1)4', 'e4 e5', 'Qe2e4', 'e4junk!']) assert.throws(() => game.move(token));
  assert.equal(positionKey(game.position), key);
  assert.equal(game.revision, revision);
});

test('comments, result markers, temporal annotations and strict notation roundtrip', () => {
  const game = new GameSession({ pgn: '[Event "Roundtrip; annotated"]\n1. Nf3! {development} / Nf6\n2. Nc3 / Nc6 ; end comment' });
  const move = parseMove(game.position, '(0T3)Nc3>>(0T2)c5~ (>L1)');
  game.play([move]);
  const exported = game.chess.export('5dpgn_timeline');
  assert.match(exported, />L1/);
  assert.equal(positionKey(createPosition({ pgn: `${exported}\n*` })), positionKey(game.position));
});

test('upstream duplicate-file Black pawn capture notation imports only as an exact legal export', () => {
  const game = new GameSession({ pgn: '[Board "Custom"]\n[7k/8/8/8/4p1p1/5N2/8/K7:0:1:b]' });
  const move = pseudoMoves(game.position).find(candidate => candidate[0][3] === 4 && candidate[1][2] === 2 && candidate[1][3] === 5);
  assert(move);
  game.play([move]);
  const exported = game.chess.export();
  assert.match(exported, /eexf3/);
  assert.equal(positionKey(createPosition({ pgn: exported })), positionKey(game.position));
  assert.throws(() => createPosition({ pgn: exported.replace('eexf3', 'eexf3oops') }));
});

test('validated session board containers do not alias committed temporal history or undo state', () => {
  const game = new GameSession({ pgn: '1. Nf3 / Nf6 2. Nc3 / Nc6' });
  const start = game.position, key = positionKey(start);
  assert.notEqual(game.position.board, game.chess.rawBoard);
  assert.notEqual(game.position.board[0], game.chess.rawBoard[0]);
  game.move('(0T3)Nc3>>(0T2)c5');
  assert.equal(positionKey(start), key);
  game.submit();
  assert.equal(positionKey(start), key);
  assert.equal(positionKey(createPosition({ pgn: game.chess.export() })), positionKey(game.position));
  game.undo();
  assert.equal(positionKey(game.position), key);
  assert.deepEqual(game.chess.rawBoard, game.position.board);
});

test('twenty submitted selfplay actions preserve full historical state through PGN roundtrip', () => {
  const game = new GameSession();
  for (let turn = 0; turn < 20; turn++) {
    const iterator = generateActions(game.position);
    const candidate = iterator.next();
    iterator.return();
    assert.equal(candidate.done, false);
    game.play(candidate.value.moves);
    assert.equal(positionKey(createPosition({ pgn: game.chess.export() })), positionKey(game.position));
  }
});
