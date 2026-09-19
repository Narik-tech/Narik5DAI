import { generateActions, inCheck, positionKey } from './rules.js';
import { evaluate, pieceValue } from './evaluate.js';

export const MATE_SCORE = 100_000;
const MATE_THRESHOLD = MATE_SCORE - 1000;
const INF = 1_000_000;
class SearchInterrupted extends Error {}
const actionKey = action => JSON.stringify(action);
const moveKey = move => JSON.stringify(move);
const colorSign = position => position.action % 2 === 0 ? 1 : -1;
const toTable = (score, ply) => score > MATE_THRESHOLD ? score + ply : score < -MATE_THRESHOLD ? score - ply : score;
const fromTable = (score, ply) => score > MATE_THRESHOLD ? score - ply : score < -MATE_THRESHOLD ? score + ply : score;

function finiteOption(value, fallback, min, max) {
  return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}

function moveFeatures(position, move) {
  const [from, to] = move;
  const mover = position.board[from[0]]?.[from[1]]?.[from[2]]?.[from[3]] || 0;
  const captured = position.board[to[0]]?.[to[1]]?.[to[2]]?.[to[3]] || 0;
  const promotion = to.length > 4 ? pieceValue(to[4]) - pieceValue(mover) : 0;
  // The third coordinate is the captured pawn in an en passant move; castling
  // contains a fourth coordinate and is not a capture.
  const captureValue = pieceValue(captured) || (move.length === 3 ? 100 : 0);
  return { mover, captureValue, promotion, temporal: from[0] !== to[0] || from[1] !== to[1] };
}

/**
 * Search complete submitted turns. No null move, late-move reductions, or
 * selective beam pruning: normal-depth scores have alpha-beta bound semantics.
 * `nodes` includes generator work ticks, making maxNodes deterministic even
 * when finding one legal multiboard action takes considerable work.
 */
export function analyze(position, options = {}) {
  const started = performance.now();
  const timeMs = finiteOption(options.timeMs, 3000, 0, 3_600_000);
  const maxDepth = Math.floor(finiteOption(options.maxDepth, 8, 1, 64));
  const maxNodes = Math.floor(finiteOption(options.maxNodes, 2_000_000, 0, 1_000_000_000));
  const qDepth = Math.floor(finiteOption(options.quiescenceDepth, 2, 0, 8));
  const maxTableEntries = Math.floor(finiteOption(options.maxTableEntries, 100_000, 0, 1_000_000));
  const deadline = started + timeMs;
  const tt = new Map(), history = new Map(), killers = new Map();
  const evalCache = new WeakMap(), checkCache = new WeakMap();
  let nodes = 0, searchNodes = 0, generationNodes = 0, qnodes = 0, ttHits = 0, cutoffs = 0;
  let interruption = null, depth = 0, bestAction = null, pv = [], score = null;
  let completed = false, status = 'incomplete', rootPartial = null;
  let activeQDepth = 0, completedQDepth = 0;
  const rootSign = colorSign(position);

  function tick(kind = 'generation') {
    if (options.shouldStop?.()) { interruption = 'cancelled'; throw new SearchInterrupted(); }
    if (nodes >= maxNodes) { interruption = 'nodes'; throw new SearchInterrupted(); }
    if (performance.now() >= deadline) { interruption = 'time'; throw new SearchInterrupted(); }
    nodes++;
    if (kind === 'generation') generationNodes++;
    else { searchNodes++; if (kind === 'quiescence') qnodes++; }
  }
  function staticScore(pos) {
    if (!evalCache.has(pos)) evalCache.set(pos, Math.max(-MATE_THRESHOLD + 1, Math.min(MATE_THRESHOLD - 1, evaluate(pos) * colorSign(pos))));
    return evalCache.get(pos);
  }
  function checked(pos) {
    if (!checkCache.has(pos)) checkCache.set(pos, inCheck(pos));
    return checkCache.get(pos);
  }
  function orderMoves(pos, moves, preferred, ply) {
    const favorites = new Set((preferred || []).map(moveKey));
    const killerMoves = new Set((killers.get(ply) || []).flat().map(moveKey));
    return moves.map((move, index) => {
      const key = moveKey(move), f = moveFeatures(pos, move);
      const from = move[0], to = move[1];
      const centralGain = Math.abs(from[2] - 3.5) + Math.abs(from[3] - 3.5) - Math.abs(to[2] - 3.5) - Math.abs(to[3] - 3.5);
      let priority = (favorites.has(key) ? 10_000_000 : 0) + f.promotion * 100;
      if (f.captureValue) priority += 1_000_000 + f.captureValue * 100 - pieceValue(f.mover);
      else priority += (killerMoves.has(key) ? 100_000 : 0) + (history.get(key) || 0) + centralGain * 10;
      // Unforced early branching expands the reply tree enormously. Explore
      // ordinary development before speculative travel unless it wins material.
      if (f.temporal) priority -= 100;
      return { move, priority, index };
    }).sort((a, b) => b.priority - a.priority || a.index - b.index).map(item => item.move);
  }
  function actions(pos, preferred, ply) {
    return generateActions(pos, { tick: () => tick(), orderMoves: (current, moves) => orderMoves(current, moves, preferred, ply) });
  }
  function rememberCutoff(pos, action, ply, remaining) {
    cutoffs++;
    if (action.some(move => { const f = moveFeatures(pos, move); return f.captureValue || f.promotion; })) return;
    const list = killers.get(ply) || [];
    const key = actionKey(action);
    killers.set(ply, [action, ...list.filter(a => actionKey(a) !== key)].slice(0, 2));
    for (const move of action) {
      const key = moveKey(move);
      history.set(key, Math.min(50_000, (history.get(key) || 0) + remaining * remaining * 20));
    }
  }
  function store(key, entry) {
    if (!maxTableEntries) return;
    if (tt.size >= maxTableEntries && !tt.has(key)) tt.delete(tt.keys().next().value);
    const old = tt.get(key);
    if (!old || entry.depth >= old.depth || entry.flag === 'exact') tt.set(key, entry);
  }
  function terminal(pos, ply) { return checked(pos) ? -MATE_SCORE + ply : 0; }

  function quiescence(pos, alpha, beta, remaining, ply) {
    tick('quiescence');
    const isCheck = checked(pos);
    const iterator = actions(pos, null, ply);
    const first = iterator.next();
    // Prove at least one legal action before using stand-pat: otherwise a
    // stalemate or mate at the horizon could be mistaken for material gain.
    if (first.done) return { score: terminal(pos, ply), pv: [] };
    let best = isCheck ? -INF : staticScore(pos), bestPv = [];
    if (!isCheck) {
      if (best >= beta || remaining <= 0) { iterator.return?.(); return { score: best, pv: [] }; }
      alpha = Math.max(alpha, best);
    }
    let next = first;
    while (!next.done) {
      const candidate = next.value;
      const noisy = isCheck || candidate.moves.some(move => {
        const f = moveFeatures(pos, move);
        return f.captureValue || f.promotion;
      });
      if (noisy) {
        // Bound checking sequences without ever standing pat in check. At the
        // emergency horizon evaluate actual legal evasions instead.
        const child = remaining <= -4
          ? { score: staticScore(candidate.position), pv: [] }
          : quiescence(candidate.position, -beta, -alpha, remaining - 1, ply + 1);
        const value = -child.score;
        if (value > best) { best = value; bestPv = [candidate.moves, ...child.pv]; }
        alpha = Math.max(alpha, value);
        if (alpha >= beta) { cutoffs++; iterator.return?.(); break; }
      }
      next = iterator.next();
    }
    return { score: best, pv: bestPv };
  }

  function negamax(pos, remaining, alpha, beta, ply, preferred = null) {
    if (remaining <= 0) return quiescence(pos, alpha, beta, activeQDepth, ply);
    tick('search');
    const key = positionKey(pos), entry = tt.get(key);
    if (entry && entry.depth >= remaining && entry.quiescenceDepth >= activeQDepth && ply > 0) {
      ttHits++;
      const value = fromTable(entry.score, ply);
      if (entry.flag === 'exact') return { score: value, pv: entry.pv };
      if (entry.flag === 'lower') alpha = Math.max(alpha, value);
      else beta = Math.min(beta, value);
      if (alpha >= beta) return { score: value, pv: entry.pv };
    }
    // Classify the resulting bound against the window actually searched. A
    // cutoff against a TT-tightened beta must never be stored as exact.
    const searchAlpha = alpha, searchBeta = beta;
    let best = -INF, bestPv = [], bestMove = null, count = 0;
    for (const candidate of actions(pos, preferred || entry?.bestAction, ply)) {
      let child;
      if (!count) child = negamax(candidate.position, remaining - 1, -beta, -alpha, ply + 1);
      else {
        child = negamax(candidate.position, remaining - 1, -alpha - 1, -alpha, ply + 1);
        const probe = -child.score;
        if (probe > alpha && probe < beta) child = negamax(candidate.position, remaining - 1, -beta, -alpha, ply + 1);
      }
      count++;
      const value = -child.score;
      if (value > best) {
        best = value; bestMove = candidate.moves; bestPv = [candidate.moves, ...child.pv];
        if (ply === 0) rootPartial = { score: best, bestAction: bestMove, pv: bestPv };
      }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) { rememberCutoff(pos, candidate.moves, ply, remaining); break; }
    }
    if (!count) return { score: terminal(pos, ply), pv: [], terminal: true };
    const flag = best <= searchAlpha ? 'upper' : best >= searchBeta ? 'lower' : 'exact';
    store(key, { depth: remaining, quiescenceDepth: activeQDepth, score: toTable(best, ply), flag, bestAction: bestMove, pv: bestPv });
    return { score: best, pv: bestPv };
  }

  function snapshot() {
    const elapsedMs = Math.max(0, performance.now() - started);
    return {
      bestAction, score: score === null ? null : Math.round(score * rootSign), depth,
      nodes, searchNodes, generationNodes, qnodes, ttHits, cutoffs, elapsedMs: Math.round(elapsedMs),
      nps: elapsedMs ? Math.round(nodes * 1000 / elapsedMs) : 0, pv, status, completed,
      stoppedReason: interruption, tableEntries: tt.size,
      effectiveQuiescenceDepth: completed ? completedQDepth : activeQDepth,
      scoreType: score === null ? 'unavailable' : Math.abs(score) > MATE_THRESHOLD ? 'mate' : 'cp',
      mateIn: score !== null && Math.abs(score) > MATE_THRESHOLD ? Math.sign(score * rootSign) * (MATE_SCORE - Math.abs(score)) : null,
      limits: { timeMs, maxDepth, maxNodes, quiescenceDepth: qDepth }
    };
  }
  try {
    const fallbackIterator = actions(position, null, 0);
    const fallback = fallbackIterator.next();
    fallbackIterator.return?.();
    if (fallback.done) {
      score = terminal(position, 0); status = score ? 'checkmate' : 'stalemate'; completed = true;
      return snapshot();
    }
    bestAction = fallback.value.moves; pv = [bestAction];
    // A legal fallback is valuable even if the first recursive iteration cannot
    // finish; its score stays explicitly unavailable until a child is searched.
    const iterations = [];
    // First broaden capture analysis at depth one; then deepen full turns. A
    // quiet warmup alone can overvalue a defended capture, so finish q1 before
    // investing in a much larger depth-two multiverse tree.
    if (options.quiescenceWarmup !== false) {
      for (let horizon = 0; horizon < qDepth; horizon++) iterations.push({ depth: 1, horizon });
    }
    for (let currentDepth = 1; currentDepth <= maxDepth; currentDepth++) iterations.push({ depth: currentDepth, horizon: qDepth });
    for (const iteration of iterations) {
      const currentDepth = iteration.depth;
      activeQDepth = iteration.horizon;
      rootPartial = null;
      const window = currentDepth > 2 && Math.abs(score ?? 0) < MATE_THRESHOLD ? 60 : INF;
      const lower = window === INF ? -INF : score - window;
      const upper = window === INF ? INF : score + window;
      let result = negamax(position, currentDepth, lower, upper, 0, bestAction);
      if (result.score <= lower || result.score >= upper) result = negamax(position, currentDepth, -INF, INF, 0, result.pv[0] || bestAction);
      score = result.score; depth = currentDepth; pv = result.pv; bestAction = pv[0] || bestAction;
      completedQDepth = activeQDepth;
      completed = true; status = 'ok';
      options.onProgress?.(snapshot());
      if (Math.abs(score) >= MATE_SCORE - currentDepth) { interruption = 'mate'; break; }
    }
    if (!interruption) interruption = 'depth';
  } catch (error) {
    if (!(error instanceof SearchInterrupted)) throw error;
    if (!completed && rootPartial) {
      bestAction = rootPartial.bestAction; score = rootPartial.score; pv = rootPartial.pv;
    }
  }
  return snapshot();
}
