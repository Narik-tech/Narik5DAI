import Chess from '5d-chess-js';
import {
  createPosition, pseudoMoves, applyMove, parseMove, formatMove, formatAction,
  canSubmit, submitPosition, inCheck, raw, validateAction, normalizePGN,
} from './rules.js';

/** A local game with transactional edits and separate partial/committed turns. */
export class GameSession {
  constructor(options = {}) {
    this.revision = 0;
    this.reset(options);
  }

  reset({ variant = 'standard', pgn } = {}) {
    const position = createPosition({ variant, pgn });
    const chess = new Chess();
    chess.skipDetection = true;
    if (pgn?.trim()) chess.import(normalizePGN(pgn, variant), variant, true);
    else chess.reset(variant);
    this.position = position;
    this.chess = chess;
    this.pending = [];
    this.history = [];
    this.undoStack = [];
    this.turnStart = position;
    this.revision++;
    return this;
  }

  assertRevision(revision) {
    if (!Number.isInteger(revision) || revision !== this.revision) {
      const error = new Error('The position changed. Refresh the game and analyze again.');
      error.statusCode = 409;
      throw error;
    }
  }

  move(input) {
    const move = parseMove(this.position, input);
    const next = applyMove(this.position, move);
    const notation = formatMove(this.position, move);
    this.chess.move(move);
    this.pending.push({ raw: move, notation, before: this.position });
    this.position = next;
    this.revision++;
  }

  submit() {
    if (!this.pending.length) throw new Error('Play a move before submitting the turn.');
    const next = submitPosition(this.position);
    const notation = formatAction(this.turnStart, this.pending.map(m => m.raw));
    const before = this.chess.state();
    // Save the start of the turn, so undo reverses the entire submitted action.
    before.rawBoard = raw.boardFuncs.copy(this.turnStart.board);
    before.rawMoveBuffer = [];
    this.chess.submit();
    this.undoStack.push({ position: this.turnStart, chess: before });
    this.history.push({ notation });
    this.position = next;
    this.turnStart = next;
    this.pending = [];
    this.revision++;
  }

  play(moves) {
    // Validate the entire proposal before mutating any live state.
    validateAction(this.position, moves);
    if (!moves.length && !this.pending.length) throw new Error('An empty turn cannot be played.');
    for (const move of moves) this.move(move);
    this.submit();
  }

  undo() {
    if (this.pending.length) {
      this.chess.undo();
      this.position = this.pending.pop().before;
    } else {
      const previous = this.undoStack.pop();
      if (!previous) throw new Error('There is no local move to undo.');
      this.position = previous.position;
      this.turnStart = previous.position;
      this.chess.state(previous.chess);
      this.history.pop();
    }
    this.revision++;
  }

  snapshot() {
    const position = this.position;
    return {
      revision: this.revision,
      position,
      active: raw.boardFuncs.active(position.board),
      present: raw.boardFuncs.present(position.board, position.action),
      isEvenTimeline: raw.boardFuncs.isEvenTimeline(position.board),
      isTurnZero: raw.boardFuncs.isTurnZero(position.board),
      canSubmit: this.pending.length > 0 && canSubmit(position),
      inCheck: inCheck(position),
      moves: pseudoMoves(position).map(move => ({ raw: move, notation: formatMove(position, move) })),
      pending: this.pending.map(({ raw: move, notation }) => ({ raw: move, notation })),
      history: this.history,
      pgn: this.chess.export(),
      variants: this.chess.variants.filter(v => v.shortName !== 'custom'),
    };
  }
}
