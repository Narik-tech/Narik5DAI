import test from 'node:test';
import assert from 'node:assert/strict';
import {
  raw, createPosition, pseudoMoves, applyMove, canSubmit, positionKey,
  generateActions, validateAction, parseMove, isTacticalMove,
} from '../src/rules.js';

const square = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
const position = board => ({ board, action: 0, promotions: [10, 9, 8, 7, 6, 5, 4, 3] });
const moveKey = move => JSON.stringify(move);
const actionKeys = actions => actions.map(action => positionKey(action.position)).sort();
const ordinary = move => move[0][0] === move[1][0] && move[0][1] === move[1][1];
const allowed = (current, move) => !ordinary(move) || raw.boardFuncs.present(current.board, current.action).includes(move[0][0]);

// Independently enumerate the selected policy using fresh geometry at each
// component, without the production generator's pruning or geometry caches.
function referenceActions(start, tacticalOnly = false) {
  const seen = new Set(), results = [];
  function visit(current, moves, tactical) {
    const key = `${tacticalOnly && tactical ? 't:' : ''}${positionKey(current)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if ((!tacticalOnly || tactical) && canSubmit(current)) results.push({ moves, position: { ...current, action: current.action + 1 } });
    for (const move of pseudoMoves(current)) if (allowed(current, move)) {
      visit(applyMove(current, move), [...moves, move], tactical || isTacticalMove(current, move));
    }
  }
  visit(start, [], false);
  return results;
}

test('optional-board search policy matches independent complete-action enumeration', () => {
  const capture = square(); capture[0][1] = 4; capture[1][2] = 1;
  const setups = [
    createPosition(),
    position([[square()], null, [square(), square(), capture]]),
    position([[square()], null, [square()], null, [square()]]),
  ];
  for (const start of setups) for (const tacticalOnly of [false, true]) {
    const expected = referenceActions(start, tacticalOnly);
    for (const cacheMoves of [false, true]) {
      const actions = [...generateActions(start, { skipOptionalSpatial: true, tacticalOnly, cacheMoves })];
      assert.deepEqual(actionKeys(actions), actionKeys(expected));
      for (const action of actions) {
        let current = start;
        for (const move of action.moves) {
          assert(allowed(current, move));
          current = applyMove(current, move);
        }
        assert.equal(positionKey(validateAction(start, action.moves)), positionKey(action.position));
      }
    }
  }
});

test('ordinary optional captures, promotions and castling stay legal but are excluded from search', () => {
  const special = square(); special[0][1] = 4; special[1][2] = 1; special[2][1] = 2;
  const small = position([[square()], null, [square(), square(), special]]);
  const castleBoard = createPosition({ pgn: '[Board "Custom"]\n[k7/8/8/8/8/8/8/4K*2R*:0:1:w]' }).board[0][0];
  const castles = position([[structuredClone(castleBoard)], null, [structuredClone(castleBoard), structuredClone(castleBoard), structuredClone(castleBoard)]]);
  for (const start of [small, castles]) {
    const rootMoves = pseudoMoves(start);
    const optional = rootMoves.filter(move => ordinary(move) && move[0][0] === 2);
    assert(optional.length);
    if (start === small) {
      assert(optional.some(move => isTacticalMove(start, move) && move[1].length === 4));
      assert(optional.some(move => move[1].length === 5));
    } else assert(optional.some(move => move.length === 4));
    let observed;
    [...generateActions(start, { skipOptionalSpatial: true, orderMoves(_current, moves) { observed = moves; return []; } })];
    assert(observed.every(move => allowed(start, move)));
    assert.equal(observed.some(move => ordinary(move) && move[0][0] === 2), false);
    assert(rootMoves.some(move => ordinary(move) && move[0][0] === 0));
    const first = rootMoves.find(move => ordinary(move) && move[0][0] === 0 && move.length === 2);
    const middle = applyMove(start, first);
    assert(canSubmit(middle));
    for (const specialMove of optional.filter(move => isTacticalMove(start, move) || move.length === 4)) {
      assert.doesNotThrow(() => validateAction(start, [first, specialMove]));
    }
  }
});

test('optional spatial preferred continuations cannot bypass policy after a legal submission', () => {
  const capture = square(); capture[0][1] = 4; capture[1][2] = 1;
  const start = position([[square()], null, [square(), square(), capture]]);
  const quiet = parseMove(start, [[0, 0, 0, 0], [0, 0, 0, 1]]);
  const middle = applyMove(start, quiet);
  assert(canSubmit(middle));
  const take = parseMove(middle, [[2, 2, 0, 1], [2, 2, 1, 2]]);
  const preferredAction = [quiet, take];
  const target = positionKey(validateAction(start, preferredAction));
  assert([...generateActions(start)].some(action => positionKey(action.position) === target));
  let skipped = 0;
  const options = { skipOptionalSpatial: true, onSkipOptionalSpatial: () => skipped++ };
  const baseline = [...generateActions(start, options)];
  const preferred = [...generateActions(start, { ...options, preferredAction })];
  assert(skipped > 0);
  assert.deepEqual(actionKeys(preferred), actionKeys(baseline));
  assert.equal(preferred.some(action => positionKey(action.position) === target), false);
});

test('cross-board moves remain available from future and inactive sources', () => {
  const starts = [
    [position([[square()], null, [square(), square(), square()]]), [[2, 2, 0, 0], [0, 0, 0, 1]]],
    [position([[square()], null, [square()], null, [square()]]), [[4, 0, 0, 0], [2, 0, 0, 1]]],
  ];
  for (const [start, jump] of starts) {
    assert(!raw.boardFuncs.present(start.board, start.action).includes(jump[0][0]));
    assert.deepEqual(parseMove(start, jump), jump);
    const actions = [...generateActions(start, { skipOptionalSpatial: true })];
    assert(actions.some(action => action.moves.some(move => moveKey(move) === moveKey(jump))));
  }
});

test('a temporal branch recomputes the present and permits captures on newly activated boards', () => {
  const source = square(); source[1][2] = 4;
  const inactive = square(); inactive[1][1] = 4; inactive[2][2] = 1;
  const start = position([Array.from({ length: 5 }, () => structuredClone(source)), [square(), square(), square()], null, [inactive]]);
  assert.deepEqual(raw.boardFuncs.present(start.board, start.action), [1]);
  assert(!raw.boardFuncs.active(start.board).includes(3));
  const branch = parseMove(start, [[0, 4, 1, 2], [0, 2, 1, 1]]);
  const middle = applyMove(start, branch);
  assert.deepEqual(raw.boardFuncs.present(middle.board, middle.action), [3]);
  const capture = parseMove(middle, [[3, 0, 1, 1], [3, 0, 2, 2]]);
  const expected = validateAction(start, [branch, capture]);
  for (const tacticalOnly of [false, true]) {
    let index = 0;
    const actions = [...generateActions(start, {
      skipOptionalSpatial: true, tacticalOnly,
      orderMoves(current, moves) {
        assert(moves.every(move => allowed(current, move)));
        const next = [branch, capture][index++];
        return next ? moves.filter(move => moveKey(move) === moveKey(next)) : [];
      },
    })];
    assert(actions.some(action => positionKey(action.position) === positionKey(expected)));
    const preferred = generateActions(start, { skipOptionalSpatial: true, tacticalOnly, preferredAction: [branch, capture] });
    assert.deepEqual(preferred.next().value.moves, [branch, capture]);
    preferred.return();
  }
});

test('the selected policy may exhaust while a legal optional-move evasion still exists', () => {
  const required = [[0, 11, 12], [7, 0, 0], [3, 0, 0]];
  const future = [[0, 8, 0], [11, 0, 0], [4, 0, 12]];
  const start = position([[required], null, [structuredClone(future), structuredClone(future), future]]);
  const prepare = [[2, 2, 0, 1], [2, 2, 0, 2]];
  const escape = [[0, 0, 0, 2], [2, 2, 0, 2]];
  assert(!allowed(start, prepare));
  // Advancing the optional board first turns the king's arrival into a branch.
  // Its different timeline geometry escapes a threat that a direct merge does
  // not, so policy exhaustion is not a proof of checkmate or stalemate.
  const saved = validateAction(start, [prepare, escape]);
  assert(saved.board[4]);
  assert([...generateActions(start)].some(action => positionKey(action.position) === positionKey(saved)));
  let excluded = 0;
  assert.deepEqual([...generateActions(start, { skipOptionalSpatial: true, onSkipOptionalSpatial: () => excluded++ })], []);
  assert(excluded > 0);
});
