import Chess from '5d-chess-js';

// Use the upstream geometry, history representation and notation. Its eager
// action generator and timeout-as-mate API are deliberately not used here.
export const raw = new Chess().raw;
const royal = piece => [11, 12, 19, 20].includes(Math.abs(piece));
const pieceAt = (board, square) => board[square[0]]?.[square[1]]?.[square[2]]?.[square[3]];
const equalMove = (a, b) => raw.validateFuncs.compareMove(a, b) === 0;

/** Guard the upstream parser's sparse-array allocations before parsing input. */
export function normalizePGN(pgn, variant = 'standard') {
  if (typeof pgn !== 'string') throw new Error('PGN must be a string.');
  if (pgn.length > 500_000) throw new Error('PGN import is limited to 500,000 characters.');
  const variants = raw.metadataFuncs.variantDict;
  const variantName = value => variants.find(([name, key]) => name.toLowerCase() === value.toLowerCase() || key === value.toLowerCase());
  if (typeof variant !== 'string' || !variantName(variant)) throw new Error('Unknown starting variant.');
  const metadata = raw.metadataFuncs.strToObj(pgn);
  if (metadata.mode !== undefined && String(metadata.mode).toLowerCase() !== '5d') throw new Error('Only 5D mode is supported.');
  const boardHeader = pgn.match(/\[board\s+"([^"]*)"\]/i);
  if (boardHeader && !variantName(boardHeader[1])) throw new Error('Unknown Board header.');
  for (const match of pgn.matchAll(/\[size\s+"([^"]*)"\]/gi)) {
    const size = /^(\d+)x(\d+)$/.exec(match[1]);
    if (!size || size.slice(1).some(value => +value < 1 || +value > 16)) throw new Error('Board dimensions must be between 1 and 16.');
  }
  const checkCoordinate = (line, turn) => {
    if (!/^[+-]?\d+$/.test(line) || !/^\d+$/.test(turn) || !Number.isSafeInteger(+line) || Math.abs(+line) > 64 || !Number.isSafeInteger(+turn) || +turn < 0 || +turn > 2048) {
      throw new Error('Import coordinates exceed the supported limits: timeline ±64, turn 0–2048.');
    }
  };
  for (const match of pgn.matchAll(/\(([+-]?\d+)T(\d+)\)/gi)) checkCoordinate(match[1], match[2]);
  for (const match of pgn.matchAll(/\[([^\]\r\n"]*):([^:\]]*):([^:\]]*):([^:\]]*)\]/g)) {
    checkCoordinate(match[2], match[3]);
    if (!['w', 'b'].includes(match[4])) throw new Error('Invalid FEN board player.');
    for (const run of match[1].matchAll(/\d+/g)) {
      if (+run[0] < 1 || +run[0] > 16) throw new Error('FEN empty-square runs must be between 1 and 16.');
    }
  }
  return boardHeader ? pgn : `[Board "${variantName(variant)[0]}"]\n${pgn}`;
}

function assertUsableBoard(board) {
  let hasBoard = false;
  const kings = [false, false];
  for (const timeline of board) {
    if (!timeline) continue;
    for (const turn of timeline) {
      if (!turn) continue;
      hasBoard = true;
      if (!Array.isArray(turn) || turn.length < 1 || turn.length > 16 || !Array.isArray(turn[0]) || turn[0].length < 1 || turn[0].length > 16) {
        throw new Error('Invalid board dimensions.');
      }
      for (const rank of turn) {
        if (!Array.isArray(rank) || rank.length !== turn[0].length || rank.some(piece => !Number.isInteger(piece) || Math.abs(piece) > 24)) throw new Error('Malformed board pieces or ranks.');
        for (const piece of rank) if (royal(piece)) kings[Math.abs(piece) % 2] = true;
      }
    }
  }
  if (!hasBoard || !kings.every(Boolean)) throw new Error('A position must contain a board and at least one royal piece of each color.');
}

export function createPosition({ variant = 'standard', pgn } = {}) {
  // Validate a selected variant even when there is no imported game.
  const normalized = normalizePGN(pgn ?? '', variant);
  const game = new Chess(undefined, variant);
  if (pgn?.trim()) {
    // Detection is performed below, without upstream's costly mate getters.
    game.skipDetection = true;
    game.import(normalized, variant, true);
    assertUsableBoard(game.rawBoardHistory[0]);
    if (game.rawMoveBuffer.length) throw new Error('PGN ends with an incomplete or illegal turn. Import fully submitted turns.');
    let position = {
      board: game.rawBoardHistory[0],
      action: game.rawStartingAction,
      promotions: game.rawPromotionPieces.slice(),
    };
    for (const moves of game.rawActionHistory) position = validateAction(position, moves);
    return position;
  }
  return { board: game.rawBoard, action: game.rawAction, promotions: game.rawPromotionPieces.slice() };
}

/** Pseudo-legal individual moves. Royal captures are threats, never played. */
export function pseudoMoves(position) {
  return raw.boardFuncs.moves(position.board, position.action, false, false, false, position.promotions)
    .filter(move => !royal(pieceAt(position.board, move[1])));
}

/** Apply a generated move. Call parseMove first when accepting untrusted input. */
export function applyMove(position, move) {
  // Upstream copies the changed single boards. Copy only timeline containers;
  // immutable historical boards remain shared among search siblings.
  const board = position.board.map(timeline => timeline?.slice() ?? timeline);
  raw.boardFuncs.move(board, move);
  return { ...position, board };
}

function attackedByNextPlayer(position) {
  const moves = raw.boardFuncs.moves(position.board, position.action + 1, false, false, false, position.promotions);
  return moves.some(move => {
    const target = pieceAt(position.board, move[1]);
    return royal(target) && Math.abs(target) % 2 === position.action % 2;
  });
}

export function canSubmit(position) {
  return raw.boardFuncs.present(position.board, position.action).length === 0 && !attackedByNextPlayer(position);
}

export function submitPosition(position) {
  if (!canSubmit(position)) throw new Error('Turn cannot be submitted: advance the present and protect every royal piece.');
  return { ...position, action: position.action + 1 };
}

/** Forced-pass check, for classifying an exhausted turn tree as mate/stalemate. */
export function inCheck(position) {
  return raw.mateFuncs.checks(position.board, position.action, true);
}

// History matters: a past royal or empty square can determine a temporal move.
// Keep the complete serialized key rather than trusting a short hash collision.
export function positionKey(position) {
  return JSON.stringify([position.action % 2, position.promotions, position.board]);
}

export function formatMove(position, move) {
  return raw.pgnFuncs.fromMove(move, position.board, position.action, '', true, true, true);
}

export function formatAction(position, moves) {
  return raw.pgnFuncs.fromAction(moves, position.board, position.action, '', true, true, true);
}

export function parseMove(position, input) {
  const move = raw.convertFuncs.move(input, position.board, position.action, position.promotions);
  const generated = pseudoMoves(position).find(candidate => equalMove(candidate, move));
  if (!generated) throw new Error('Illegal piece move in this position.');
  return generated;
}

export function validateAction(position, moves) {
  if (!Array.isArray(moves)) throw new Error('An action must be an ordered array of moves.');
  let next = position;
  for (const move of moves) next = applyMove(next, parseMove(next, move));
  return submitPosition(next);
}

/**
 * Exhaustive, lazy legal action generation. A yield is a legal submission, not
 * a leaf: the player may still move on optional boards. Individual moves may
 * expose a king temporarily; only the resulting submitted action must be safe.
 * Each move consumes at least one playable latest board, so a turn is finite.
 */
export function* generateActions(position, { tick = () => {}, orderMoves = (_position, moves) => moves } = {}) {
  const visited = new Set();
  const path = [];
  function* visit(current) {
    tick();
    const key = positionKey(current);
    if (visited.has(key)) return;
    visited.add(key);
    if (canSubmit(current)) {
      yield { moves: path.slice(), position: { ...current, action: current.action + 1 } };
    }
    const moves = orderMoves(current, pseudoMoves(current));
    for (const move of moves) {
      tick();
      path.push(move);
      yield* visit(applyMove(current, move));
      path.pop();
    }
  }
  yield* visit(position);
}
