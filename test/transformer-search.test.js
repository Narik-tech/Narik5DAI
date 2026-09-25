import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, MATE_SCORE } from '../src/transformer-search.js';
import { applyMove, canSubmit, createPosition, formatAction, generateActions, inCheck, positionKey, pseudoMoves, raw, validateAction } from '../src/rules.js';

const limits = { timeMs: 10000, maxNodes: 100000, maxDepth: 1 };
const zero = async positions => positions.map(() => 0);
const smallBoard = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
const smallPosition = (board, action = 0) => ({ board, action, promotions: [10, 9, 8, 7, 6, 5, 4, 3] });
function usesOptionalBoard(position, moves) {
  let current = position;
  for (const move of moves) {
    if (!raw.boardFuncs.present(current.board, current.action).includes(move[0][0])) return true;
    current = applyMove(current, move);
  }
  return false;
}
function firstActions(position, count = 8) {
  const result = [];
  for (const candidate of generateActions(position)) {
    result.push(candidate);
    if (result.length === count) break;
  }
  return result;
}
function optionalSuccessorKeys(position) {
  const present = raw.boardFuncs.present(position.board, position.action);
  return pseudoMoves(position).filter(move => !present.includes(move[0][0])).map(move => {
    const next = applyMove(position, move);
    return positionKey(canSubmit(next) ? { ...next, action: next.action + 1 } : next);
  });
}
function validatePv(position, result) {
  let current = position;
  for (const action of result.pv) current = validateAction(current, action);
  return current;
}
function fractionalValue(position) {
  let hash = 2166136261;
  for (const char of positionKey(position)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 2001 - 1000) / 1000;
}
// Independent exhaustive minimax over the same bounded candidate universe.
// Fractional values exercise ordering and backups without integer rounding.
function minimax(position, remaining, candidateLimit, innerCandidateLimit = candidateLimit, ply = 0) {
  const side = position.action % 2 ? -1 : 1;
  if (!remaining && firstActions(position, 1).length) return { score: fractionalValue(position), actions: [] };
  // Independently order the synchronous rules traversal by each component's
  // resulting state, then partition complete submissions before applying caps.
  const all = [...generateActions(position, { orderMoves: (current, moves) => {
    const present = raw.boardFuncs.present(current.board, current.action);
    const value = move => {
      const next = applyMove(current, move);
      if (!canSubmit(next)) return fractionalValue(next) * side;
      const submitted = { ...next, action: next.action + 1 };
      if (!firstActions(submitted, 1).length) return inCheck(submitted) ? MATE_SCORE - ply - 1 : 0;
      return fractionalValue(submitted) * side;
    };
    return moves.map((move, index) => ({ move, index, required: present.includes(move[0][0]), value: value(move) }))
      .sort((a, b) => Number(b.required) - Number(a.required) || b.value - a.value || a.index - b.index)
      .map(item => item.move);
  } })];
  const choices = [
    ...all.filter(candidate => !usesOptionalBoard(position, candidate.moves)),
    ...all.filter(candidate => usesOptionalBoard(position, candidate.moves)),
  ].slice(0, ply ? innerCandidateLimit : candidateLimit);
  if (!choices.length) return { score: inCheck(position) ? side * (-MATE_SCORE + ply) : 0, actions: [] };
  let best = -Infinity, score, actions = [];
  for (const candidate of choices) {
    const value = minimax(candidate.position, remaining - 1, candidateLimit, innerCandidateLimit, ply + 1).score;
    if (value * side > best) { best = value * side; score = value; actions = [candidate.moves]; }
    else if (value * side === best) actions.push(candidate.moves);
  }
  return { score, actions };
}

test('neural batch values select different legal actions for White without changing the position', async () => {
  const position = createPosition(), original = structuredClone(position);
  const choices = firstActions(position);
  for (const favorite of [choices[0], choices.at(-1)]) {
    const wanted = positionKey(favorite.position), seen = [];
    const result = await analyze(position, { ...limits, candidateLimit: 8,
      evaluateBatch: async positions => { seen.push(...positions.map(positionKey)); return positions.map(pos => positionKey(pos) === wanted ? 321 : -100); },
    });
    assert.equal(result.engine, 'transformer');
    assert.equal(result.searchPolicy, 'transformer-ranked-depth');
    assert.equal(result.depth, 1);
    assert.equal(result.score, 321);
    assert.equal(result.completed, true);
    assert.deepEqual(result.bestAction, favorite.moves);
    assert.deepEqual(seen.toSorted(), firstActions(position, 64).map(candidate => positionKey(candidate.position)).sort());
    assert.equal(result.nodes, result.searchNodes + result.generationNodes);
    validatePv(position, result);
  }
  assert.deepEqual(position, original);
});

test('Black minimizes the White-perspective neural value', async () => {
  const position = createPosition({ pgn: '1. e4' });
  const favorite = firstActions(position).at(-1), wanted = positionKey(favorite.position);
  const result = await analyze(position, { ...limits, candidateLimit: 8,
    evaluateBatch: async positions => positions.map(pos => positionKey(pos) === wanted ? -475 : 200),
  });
  assert.deepEqual(result.bestAction, favorite.moves);
  assert.equal(result.score, -475);
  validatePv(position, result);
});

test('both colors can select their strongest partial move beyond the raw full-turn cap', async () => {
  for (const position of [createPosition(), createPosition({ pgn: '1. e4' })]) {
    const choices = firstActions(position, 64), favorite = choices.at(-1);
    const wanted = positionKey(favorite.position), side = position.action % 2 ? -1 : 1;
    const result = await analyze(position, { ...limits, candidateLimit: 1,
      evaluateBatch: async positions => positions.map(pos => positionKey(pos) === wanted ? side * 750 : 0),
    });
    assert.notDeepEqual(favorite.moves, choices[0].moves);
    assert.deepEqual(result.bestAction, favorite.moves);
    assert.equal(result.score, side * 750);
    assert.equal(result.rootActionsSearched, 1);
    validatePv(position, result);
  }
});

test('turn-zero continuations agree after submitting d4 at the same remaining depth', async () => {
  const position = createPosition({ variant: 'turn_zero' });
  const d4 = firstActions(position, 64).find(candidate => formatAction(position, candidate.moves) === '(0T1)d4');
  const replies = firstActions(d4.position, 64);
  const replyValues = new Map([['(0T1)e5', -50], ['(0T1)h5', -100], ['(0T1)Nf6', -500]]);
  const values = new Map([[positionKey(d4.position), 1000], ...replies.map(candidate => [
    positionKey(candidate.position), replyValues.get(formatAction(d4.position, candidate.moves)) ?? 100,
  ])]);
  const evaluateBatch = async positions => positions.map(pos => values.get(positionKey(pos)) ?? -1000);

  for (const [candidateOptions, expectedReply] of [[{}, '(0T1)Nf6'], [{ candidateLimit: 12 }, '(0T1)Nf6']]) {
    const options = { ...limits, ...candidateOptions, evaluateBatch };
    const initial = await analyze(position, { ...options, maxDepth: 2 });
    const submitted = validateAction(position, d4.moves);
    const continuation = await analyze(submitted, { ...options, maxDepth: 1 });
    assert.equal(initial.depth, 2);
    assert.equal(continuation.depth, 1);
    assert.deepEqual(initial.bestAction, d4.moves);
    assert.equal(formatAction(submitted, continuation.bestAction), expectedReply);
    assert.deepEqual(initial.pv.slice(1), continuation.pv);
    assert.equal(initial.score, continuation.score);
    validatePv(position, initial);
  }
});

test('ranked depth search respects its ceiling and returns a full-turn legal PV', async () => {
  const position = createPosition(), reports = [];
  const result = await analyze(position, { ...limits, maxDepth: 3, candidateLimit: 4, innerCandidateLimit: 3, maxCachedPositions: 2,
    evaluateBatch: zero, onProgress: report => { if (report.completed) reports.push(report.depth); },
  });
  assert.equal(result.depth, 3);
  assert.equal(result.stoppedReason, 'depth');
  assert.equal(result.pv.length, 3);
  assert.equal(result.rootActionsSearched, 4);
  assert.equal(result.cutoffs, 0);
  assert.equal('beamWidth' in result, false);
  assert.equal('beamPruned' in result, false);
  assert.equal('beamWidth' in result.limits, false);
  assert(result.candidateCacheEntries <= 2);
  assert.deepEqual([...new Set(reports)], [1, 2, 3]);
  validatePv(position, result);
});

test('a sixth-ranked shallow move remains searchable and wins at depth two', async () => {
  const position = createPosition(), choices = firstActions(position);
  const favorite = choices[5], values = new Map();
  choices.forEach((candidate, index) => {
    values.set(positionKey(candidate.position), 800 - index * 100);
    for (const reply of generateActions(candidate.position)) {
      values.set(positionKey(reply.position), candidate === favorite ? 500 : -1000);
    }
  });
  const evaluateBatch = async positions => positions.map(pos => values.get(positionKey(pos)) ?? 0);
  const shallow = await analyze(position, { ...limits, candidateLimit: 8, evaluateBatch });
  assert.deepEqual(shallow.bestAction, choices[0].moves);
  const result = await analyze(position, { ...limits, maxDepth: 2, candidateLimit: 8, evaluateBatch });
  assert.equal(result.depth, 2);
  assert.equal(result.rootActionsSearched, 8);
  assert.equal(result.score, 500);
  assert.deepEqual(result.bestAction, favorite.moves);
  assert.equal(result.pv.length, 2);
  validatePv(position, result);
});

test('an exhausted frontier agrees with fractional minimax for both colors, horizons, and candidate caps', async () => {
  for (const position of [createPosition(), createPosition({ pgn: '1. e4' })]) {
    for (const [candidateLimit, innerCandidateLimit] of [[2, 2], [4, 4], [5, 3]]) {
      for (const maxDepth of [1, 2, 3]) {
        const expected = minimax(position, maxDepth, candidateLimit, innerCandidateLimit);
        const result = await analyze(position, { ...limits, maxDepth, candidateLimit, innerCandidateLimit,
          evaluateBatch: async positions => positions.map(fractionalValue),
        });
        const context = `side=${position.action % 2}, depth=${maxDepth}, caps=${candidateLimit}/${innerCandidateLimit}`;
        assert.equal(result.depth, maxDepth, context);
        assert.equal(result.score, Math.round(expected.score), context);
        assert(expected.actions.some(action => JSON.stringify(action) === JSON.stringify(result.bestAction)), context);
        assert.equal(result.rootActionsSearched, candidateLimit, context);
        assert.equal(result.pv.length, maxDepth, context);
        validatePv(position, result);
      }
    }
  }
});

test('multiple active boards are evaluated and played as complete submissions', async () => {
  const position = createPosition({ variant: 'two_timelines' });
  const result = await analyze(position, { ...limits, candidateLimit: 4, evaluateBatch: zero });
  assert.equal(result.depth, 1);
  assert(result.bestAction.length >= 2);
  assert.equal(validatePv(position, result).action, 1);
});

test('candidate ordering averages every component before promoting the submitted True value', async () => {
  for (const action of [0, 1]) {
    const position = smallPosition([
      Array.from({ length: action + 1 }, smallBoard), null,
      Array.from({ length: action + 1 }, smallBoard),
    ], action);
    const side = action ? -1 : 1;
    const choices = [...generateActions(position)];
    const multi = choices.filter(candidate => candidate.moves.length === 2);
    const first = multi[0], partialKey = positionKey(applyMove(position, first.moves[0]));
    const alternate = multi.find(candidate => positionKey(applyMove(position, candidate.moves[0])) !== partialKey
      && JSON.stringify(candidate.moves[0]) !== JSON.stringify(first.moves[1]));
    const single = choices.find(candidate => candidate.moves.length === 1);
    for (const [favorite, fullValue] of [[alternate, 900], [single, 600]]) {
      const wanted = positionKey(favorite.position);
      let stop = false;
      const result = await analyze(position, { ...limits, candidateLimit: 256,
        shouldStop: () => stop,
        onProgress: report => { if (report.completed) stop = true; },
        evaluateBatch: async positions => positions.map(pos => side * (
          positionKey(pos) === partialKey ? 1000 : positionKey(pos) === wanted ? fullValue : 0)),
      });
      assert.equal(result.trueEvaluations, 1, 'only the scheduled candidate becomes True');
      if (favorite === alternate) {
        // (1000 + 0) / 2 beats (0 + 900) / 2, although its full score is worse.
        assert.equal(positionKey(applyMove(position, result.bestAction[0])), partialKey);
        assert.equal(Math.abs(result.score), 0, 'the returned score is the full True value, not the mean');
        assert.equal(result.depthStats[0].searchedMoves, 0, 'the new True score drops behind candidates');
      } else {
        // 600 beats (1000 + 0) / 2. Summing components would select incorrectly.
        assert.deepEqual(result.bestAction, single.moves);
        assert.equal(result.score, side * 600);
      }
      validatePv(position, result);
    }
  }
});

test('the shared top rank deepens while leaving room for shorter side-lines', async () => {
  const position = createPosition();
  let stop = false;
  const result = await analyze(position, { ...limits, maxDepth: 5, candidateLimit: 8,
    shouldStop: () => stop, evaluateBatch: zero,
    onProgress: report => { if (report.depth === 5) stop = true; },
  });
  assert.equal(result.depth, 5);
  assert.equal(result.pvDepth, 5);
  assert.equal(result.rootActionsSearched, 2);
  assert(result.trueEvaluations > result.depth);
  assert.equal(result.expansionRank, 1);
  assert.equal(result.stoppedReason, 'cancelled');
  assert(result.depthStats.every(level => level.candidates > 0 && level.trueEvaluations > 0),
    'deeper search still proceeds before exhausting each frontier');
  assert.deepEqual(result.rankings[0].entries.slice(0, 2).map(entry => entry.line.length), [5, 2]);
  validatePv(position, result);
});

test('a two-turn side-line catches up to three before the five-turn leader deepens again', async () => {
  const position = createPosition(), reports = [];
  let stop = false;
  const result = await analyze(position, { ...limits, maxDepth: 8, candidateLimit: 2, innerCandidateLimit: 1,
    shouldStop: () => stop, evaluateBatch: zero,
    onProgress: report => { reports.push(report); if (report.depth >= 6) stop = true; },
  });
  const five = reports.find(report => report.depth === 5).rankings[0].entries;
  const six = reports.find(report => report.depth === 6).rankings[0].entries;
  assert.deepEqual(five.map(entry => entry.line.length), [5, 2]);
  assert.deepEqual(six.map(entry => entry.line.length), [6, 3]);
  assert(six.every(entry => entry.evaluationType === 'true'));
  assert.deepEqual(six.map(entry => entry.id), five.map(entry => entry.id),
    'extra search does not artificially promote the side-line in the ranking');
  assert.equal(result.stoppedReason, 'cancelled');
  for (const entry of six) {
    let current = position;
    for (const action of entry.line) current = validateAction(current, [action]);
  }
  validatePv(position, result);
});

test('ranked search can reach beyond the former UI depth ceiling with legal complete turns', async () => {
  const position = createPosition();
  const result = await analyze(position, { ...limits, maxDepth: 20, candidateLimit: 1, evaluateBatch: zero });
  assert.equal(result.depth, 20);
  assert.equal(result.pvDepth, 20);
  assert.equal(result.selectiveDepth, 20);
  assert.equal(result.stoppedReason, 'depth');
  assert.equal(result.expansionRank, null, 'every admitted candidate has been evaluated');
  validatePv(position, result);
});

test('locked-king search deepens without spending its budget proving every shallow successor terminal', async () => {
  const position = createPosition({ pgn: '[Board "custom"]\n[k7/pn6/K7/8/8/8/6PB/8:0:1:w]' });
  const before = positionKey(position);
  let stop = false;
  // Equal scores isolate terminal-probe work from parent-rank changes that
  // redirect the search. Unbounded shallow probes exceed this work budget.
  const result = await analyze(position, { ...limits, maxNodes: 10000, maxDepth: 12,
    evaluateBatch: zero,
    shouldStop: () => stop,
    onProgress: report => { if (report.depth >= 6) stop = true; },
  });
  assert.equal(result.depth, 6);
  assert.equal(result.stoppedReason, 'cancelled');
  assert(result.nodes < 10000, 'terminal proofs for unselected candidates must not consume the work budget');
  assert.equal(positionKey(position), before);
  validatePv(position, result);
});

test('new True replies replace the parent neural value for both colors', async () => {
  for (const position of [createPosition(), createPosition({ pgn: '1. e4' })]) {
    const side = position.action % 2 ? -1 : 1;
    const favorite = firstActions(position)[0], rootKey = positionKey(favorite.position);
    const replies = new Set(firstActions(favorite.position, 64).map(candidate => positionKey(candidate.position)));
    let stop = false;
    const result = await analyze(position, { ...limits, maxDepth: 3, candidateLimit: 4,
      shouldStop: () => stop,
      onProgress: report => { if (report.depth === 2) stop = true; },
      evaluateBatch: async positions => positions.map(pos => side * (
        positionKey(pos) === rootKey ? 1000 : replies.has(positionKey(pos)) ? -400 : -1000)),
    });
    assert.deepEqual(result.bestAction, favorite.moves);
    assert.equal(result.score, side * -400);
    assert.equal(result.pvDepth, 2);
    assert.equal(result.trueEvaluations, 2);
    validatePv(position, result);
  }
});

test('strongest partial successors compose a legal multi-board turn with correct action semantics', async () => {
  const position = createPosition({ variant: 'two_timelines' });
  const firstBoard = raw.boardFuncs.present(position.board, position.action)[0];
  const spatial = move => move[0][0] === move[1][0] && move[0][1] === move[1][1];
  const first = pseudoMoves(position).filter(move => spatial(move) && move[0][0] === firstBoard).at(-1);
  const partial = applyMove(position, first);
  const second = pseudoMoves(partial).filter(spatial).at(-1);
  const submitted = validateAction(position, [first, second]);
  const partialKey = positionKey(partial), wanted = positionKey(submitted), seen = [];
  assert.equal(canSubmit(partial), false);
  const result = await analyze(position, { ...limits, candidateLimit: 1,
    evaluateBatch: async positions => {
      seen.push(...positions.map(positionKey));
      for (const pos of positions) {
        if (pos.action === position.action) assert.equal(canSubmit(pos), false, 'incomplete turns retain their mover');
      }
      return positions.map(pos => positionKey(pos) === partialKey ? 1000 : positionKey(pos) === wanted ? 900 : -100);
    },
  });
  assert.deepEqual(result.bestAction, [first, second]);
  assert.equal(result.score, 900);
  for (const move of pseudoMoves(position)) {
    const next = applyMove(position, move);
    const evaluated = canSubmit(next) ? { ...next, action: next.action + 1 } : next;
    assert(seen.includes(positionKey(evaluated)), 'every distinct root partial successor must be evaluated before the cap');
  }
  assert(seen.includes(partialKey));
  assert(seen.includes(wanted));
  assert.equal(seen.includes(positionKey({ ...submitted, action: position.action })), false, 'complete turns advance the action before evaluation');
  assert.equal(new Set(seen).size, seen.length, 'full candidates reuse their partial successor scores');
  assert.equal(positionKey(validatePv(position, result)), wanted);
});

test('required-board alternatives fill the root cap before future or inactive boards', async () => {
  const starts = [
    smallPosition([[smallBoard()], null, [smallBoard(), smallBoard(), smallBoard()]]),
    smallPosition([[smallBoard(), smallBoard(), smallBoard()], null, [smallBoard()]]),
    smallPosition([[smallBoard()], null, [smallBoard()], null, [smallBoard()]]),
    smallPosition([[smallBoard(), smallBoard()], null, [smallBoard(), smallBoard(), smallBoard(), smallBoard()]], 1),
  ];
  for (const position of starts) {
    const before = positionKey(position);
    const all = [...generateActions(position)];
    const required = all.filter(candidate => !usesOptionalBoard(position, candidate.moves));
    const optional = new Set(all.filter(candidate => usesOptionalBoard(position, candidate.moves)).map(candidate => positionKey(candidate.position)));
    for (const key of optionalSuccessorKeys(position)) optional.add(key);
    const expected = required.slice(0, 3), seen = [];
    const favorite = positionKey(expected[2].position);
    const result = await analyze(position, { ...limits, candidateLimit: 3,
      evaluateBatch: async positions => {
        seen.push(...positions.map(positionKey));
        return positions.map(pos => (position.action % 2 ? -1 : 1)
          * (positionKey(pos) === favorite ? 321 : optional.has(positionKey(pos)) ? 10000 : 0));
      },
    });
    assert.equal(result.depth, 1);
    assert(seen.includes(favorite), 'the chosen required successor must be evaluated');
    assert(seen.every(key => !optional.has(key)), 'optional continuations must not consume inference before the required-only cap is filled');
    assert.equal(usesOptionalBoard(position, result.bestAction), false);
    assert.equal(positionKey(validatePv(position, result)), favorite);
    assert.equal(positionKey(position), before);
  }
});

test('required-board alternatives also take priority under a separate reply cap', async () => {
  const position = smallPosition([[smallBoard()], null, [smallBoard(), smallBoard(), smallBoard(), smallBoard()]]);
  const root = firstActions(position, 1)[0];
  const all = [...generateActions(root.position)];
  const replies = all.filter(candidate => !usesOptionalBoard(root.position, candidate.moves)).slice(0, 3);
  const optional = new Set(all.filter(candidate => usesOptionalBoard(root.position, candidate.moves)).map(candidate => positionKey(candidate.position)));
  for (const key of optionalSuccessorKeys(root.position)) optional.add(key);
  const favorite = positionKey(replies[2].position), batches = [];
  const result = await analyze(position, { ...limits, maxDepth: 2, candidateLimit: 1, innerCandidateLimit: 3,
    evaluateBatch: async positions => {
      batches.push(positions.map(positionKey));
      return positions.map(pos => positionKey(pos) === favorite ? -475 : optional.has(positionKey(pos)) ? -10000 : 0);
    },
  });
  assert.equal(result.depth, 2);
  assert(batches.flat().includes(positionKey(root.position)));
  for (const reply of replies) assert(batches.flat().includes(positionKey(reply.position)));
  assert.equal(result.score, -475);
  assert.equal(positionKey(validatePv(position, result)), favorite);
});

test('optional turns remain searchable after every required-only turn without duplicates', async () => {
  const position = smallPosition([[smallBoard()], null, [smallBoard(), smallBoard(), smallBoard()]]);
  const all = [...generateActions(position)];
  const favorite = all.find(candidate => candidate.moves[0][0][0] === 2);
  const wanted = positionKey(favorite.position), seen = [];
  const result = await analyze(position, { ...limits, candidateLimit: 256,
    evaluateBatch: async positions => {
      seen.push(...positions.map(positionKey));
      return positions.map(pos => positionKey(pos) === wanted ? 500 : 0);
    },
  });
  assert.equal(result.depth, 1);
  assert.equal(result.candidateCaps, 0);
  for (const candidate of all) assert(seen.includes(positionKey(candidate.position)), 'every full candidate has a score');
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(positionKey(validatePv(position, result)), wanted);
});

test('an optional-board move can still be the only way to avoid a terminal position', async () => {
  const required = [[0, 11, 12], [7, 0, 0], [3, 0, 0]];
  const future = [[0, 8, 0], [11, 0, 0], [4, 0, 12]];
  const position = smallPosition([[required], null, [structuredClone(future), structuredClone(future), future]]);
  const result = await analyze(position, { ...limits, candidateLimit: 1, evaluateBatch: zero });
  assert.equal(result.depth, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.bestAction[0][0][0], 2);
  validatePv(position, result);
});

test('larger candidate caps split inference requests at the service batch limit', async () => {
  const board = Array.from({ length: 12 }, () => Array(12).fill(0));
  board[0][0] = 12; board[11][11] = 11;
  for (const [rank, file] of [[1, 2], [2, 4], [4, 1], [5, 5], [6, 3], [3, 6]]) board[rank][file] = 10;
  const position = smallPosition([[board]]), sizes = [];
  assert(pseudoMoves(position).length > 128, 'one prefix must exceed the inference batch limit');
  const result = await analyze(position, { ...limits, candidateLimit: 256,
    evaluateBatch: async positions => { sizes.push(positions.length); return positions.map(() => 0); },
  });
  assert.equal(result.depth, 1);
  assert(sizes.includes(128));
  assert(sizes.every(size => size > 0 && size <= 128));
  assert(sizes.reduce((total, size) => total + size, 0) > 128);
  validatePv(position, result);
});

test('zero budgets and candidate caps cannot fabricate terminal outcomes', async () => {
  const position = createPosition();
  for (const budget of [{ maxNodes: 0 }, { timeMs: 0 }]) {
    const result = await analyze(position, { ...limits, ...budget, evaluateBatch: zero });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.completed, false);
    assert.equal(result.score, null);
    assert.equal(result.nodes, 0);
    assert.equal(result.bestAction, null);
  }
  const capped = await analyze(position, { ...limits, candidateLimit: 1, evaluateBatch: zero });
  assert.equal(capped.status, 'ok');
  assert.equal(capped.scoreType, 'cp');
  assert(capped.candidateCaps > 0);
  validatePv(position, capped);
});

test('a small work budget preserves a legal but explicitly unscored fallback', async () => {
  const position = createPosition();
  const result = await analyze(position, { ...limits, maxNodes: 4, evaluateBatch: zero });
  assert.equal(result.nodes, 4);
  assert.equal(result.stoppedReason, 'nodes');
  assert.equal(result.completed, false);
  assert.equal(result.score, null);
  assert.equal(result.scoreType, 'unavailable');
  assert(result.bestAction);
  validatePv(position, result);
});

test('cancellation after an awaited batch discards that batch', async () => {
  const position = createPosition();
  let stop = false;
  const result = await analyze(position, { ...limits, candidateLimit: 2, shouldStop: () => stop,
    evaluateBatch: async positions => { await Promise.resolve(); stop = true; return positions.map(() => 999); },
  });
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.score, null);
  assert.equal(result.completed, false);
  validatePv(position, result);
});

test('cancellation retains the latest backed true evaluation', async () => {
  const position = createPosition();
  let stop = false, saved;
  const result = await analyze(position, { ...limits, maxDepth: 4, candidateLimit: 4, evaluateBatch: zero,
    shouldStop: () => stop,
    onProgress: report => { if (report.completed) { saved = report; stop = true; } },
  });
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.depth, 1);
  assert.equal(result.completed, true);
  assert.deepEqual(result.pv, saved.pv);
});

test('time limit interrupts a stalled evaluator', async () => {
  let called = false;
  const before = performance.now();
  const result = await analyze(createPosition(), { ...limits, candidateLimit: 1, timeMs: 50,
    evaluateBatch: () => { called = true; return new Promise(() => {}); },
  });
  assert(called);
  assert.equal(result.stoppedReason, 'time');
  assert.equal(result.score, null);
  assert(performance.now() - before < 1000);
});

test('terminal statuses require exhausted unrestricted legal generation', async () => {
  const mate = createPosition({ pgn: '1. e3 / f6 2. Qe2 / Nc6 3. Qh5' });
  const stale = createPosition({ pgn: '[Board "Custom"]\n[Size "3x3"]\n[1q1/2k/K2:0:1:w]' });
  for (const [position, expected, score] of [[mate, 'checkmate', MATE_SCORE], [stale, 'stalemate', 0]]) {
    const result = await analyze(position, { ...limits, evaluateBatch: () => { throw new Error('Terminal requires no model call.'); } });
    assert.equal(result.status, expected);
    assert.equal(result.score, score);
    assert.equal(result.completed, true);
    assert.equal(result.bestAction, null);
    assert.equal(result.mateProven, expected === 'checkmate');
    assert.equal(result.terminalProof, 'unrestricted-legal-exhaustion');
  }
});

test('mate proof survives a winning witness but requires every move for a losing claim', async () => {
  const winning = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[1q1k/4/4/K3:0:1:w]\n[1q1k/4/4/K3:0:1:b]\n[3k/4/1N2/K3:0:2:w]' });
  const won = await analyze(winning, { ...limits, evaluateBatch: zero });
  assert.equal(won.mateIn, 1);
  assert.equal(won.mateProven, true);
  validatePv(winning, won);
  const cappedWin = await analyze(winning, { ...limits, candidateLimit: 9, evaluateBatch: zero });
  assert(cappedWin.candidateCaps > 0);
  assert.equal(cappedWin.mateIn, 1);
  assert.equal(cappedWin.mateProven, true, 'a certified winning witness survives a candidate cap');
  const losing = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[4/k3/QK1q/n3:0:1:w]' });
  const lost = await analyze(losing, { ...limits, maxDepth: 3, evaluateBatch: zero });
  assert.equal(lost.mateIn, -2);
  assert.equal(lost.mateProven, true);
  const selective = await analyze(losing, { ...limits, maxDepth: 3, evaluateBatch: zero, candidateLimit: 1 });
  assert.equal(selective.mateIn, null);
  assert.equal(selective.mateProven, false);
  assert.equal(selective.scoreType, 'cp');
  validatePv(losing, selective);
  const replyCap = await analyze(losing, { ...limits, maxDepth: 3, evaluateBatch: zero, innerCandidateLimit: 1 });
  assert(replyCap.candidateCaps > 0);
  assert.equal(replyCap.mateIn, -2);
  assert.equal(replyCap.mateProven, true, 'each legal root move has a certified opponent winning witness');
});

test('a losing continuation cannot claim that every root move loses', async () => {
  const position = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[4/2q1/4/K2k:0:1:w]' });
  const safe = firstActions(position).find(candidate => formatAction(position, candidate.moves) === '(0T1)Ka2');
  const safeKey = positionKey(safe.position);
  // Search the safe move first. Black's mating reply to Kb1 must not turn
  // a losing root alternative into a losing claim about every root move.
  const result = await analyze(position, { ...limits, maxDepth: 2,
    evaluateBatch: async positions => positions.map(pos => positionKey(pos) === safeKey ? 100 : 0),
  });
  assert.equal(result.depth, 2);
  assert.equal(result.cutoffs, 0);
  assert.equal(result.candidateCaps, 0);
  assert.deepEqual(result.bestAction, safe.moves);
  assert.equal(result.score, 0);
  assert.equal(result.mateIn, null);
  assert.equal(result.mateProven, false);
  assert.equal(result.scoreType, 'cp');
  validatePv(position, result);
});

test('neural values cannot masquerade as mate scores', async () => {
  const result = await analyze(createPosition(), { ...limits, candidateLimit: 2, evaluateBatch: async positions => positions.map(() => 1e10) });
  assert.equal(result.scoreType, 'cp');
  assert.equal(result.mateIn, null);
  assert(result.score < MATE_SCORE - 1000);
});

test('model failures and malformed value batches propagate', async () => {
  const position = createPosition();
  await assert.rejects(analyze(position), /requires evaluateBatch/);
  await assert.rejects(analyze(position, { ...limits, candidateLimit: 1, evaluateBatch: async () => { throw new Error('Model unavailable'); } }), /Model unavailable/);
  for (const bad of [[], [NaN], [Infinity], ['123']]) {
    await assert.rejects(analyze(position, { ...limits, candidateLimit: 1, evaluateBatch: async () => bad }), /finite White-centipawn/);
  }
});
