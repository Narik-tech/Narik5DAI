import { createPositionKeyCache, generateActions, inCheck } from './rules.js';

export const MATE_SCORE = 100_000;
const MATE_THRESHOLD = MATE_SCORE - 1000;
const sign = position => position.action % 2 === 0 ? 1 : -1;
const finite = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Number(value))) : fallback;
class SearchInterrupted extends Error {}

/**
 * Neural value search over complete legal submissions. The first candidateLimit
 * actions at each position are scored in GPU-friendly batches, then searched
 * in neural-value order with alpha-beta. Every generated candidate is eligible
 * for deepening; only a search bound can cut off the remaining alternatives.
 * Candidate caps still make this selective, not exhaustive full-rule minimax.
 * Values are always White centipawns.
 * The evaluator is required: no classical evaluation replaces a missing model.
 */
export async function analyze(position, options = {}) {
  if (typeof options.evaluateBatch !== 'function') throw new Error('Transformer search requires evaluateBatch.');
  const started = performance.now();
  const timeMs = finite(options.timeMs, 3000, 0, 3_600_000);
  const maxDepth = Math.floor(finite(options.maxDepth, 4, 1, 64));
  const maxNodes = Math.floor(finite(options.maxNodes, 200_000, 0, 1_000_000_000));
  const candidateLimit = Math.floor(finite(options.candidateLimit, 64, 1, 256));
  // The same position must see the same candidate set when it becomes the
  // root. A smaller default for replies excluded every opening knight move
  // for Black (the first 16 generated actions are pawn moves). Advanced callers
  // may still opt into a different reply cap, accepting that asymmetry.
  const innerCandidateLimit = Math.floor(finite(options.innerCandidateLimit, candidateLimit, 1, 256));
  const maxCachedPositions = Math.floor(finite(options.maxCachedPositions, 128, 0, 512));
  const deadline = started + timeMs, rootSign = sign(position);
  const keyPosition = createPositionKeyCache();
  const candidateCache = new Map(), terminalCache = new WeakMap(), valueCache = new WeakMap();
  const preferredActions = new WeakMap();
  let rootCandidates = null;
  let nodes = 0, searchNodes = 0, generationNodes = 0, evaluations = 0, inferenceBatches = 0;
  let depth = 0, searchingDepth = 0, selectiveDepth = 0, rootActionsSearched = 0;
  let bestAction = null, pv = [], score = null, rootPartial = null;
  let completed = false, status = 'incomplete', stoppedReason = null;
  let mateProven = false;
  let candidateCaps = 0, cutoffs = 0, lastProgress = started;

  function check(includeNodes = true) {
    if (options.shouldStop?.()) stoppedReason = 'cancelled';
    else if (includeNodes && nodes >= maxNodes) stoppedReason = 'nodes';
    else if (performance.now() >= deadline) stoppedReason = 'time';
    else return;
    throw new SearchInterrupted();
  }
  function tick(kind = 'generation') {
    check(); nodes++;
    if (kind === 'generation') generationNodes++;
    else searchNodes++;
    if (options.onProgress && bestAction && performance.now() - lastProgress >= 250) {
      lastProgress = performance.now(); options.onProgress(snapshot());
    }
  }
  function iterator(pos) {
    return generateActions(pos, { tick, keyPosition, skipOptionalSpatial: false });
  }
  function terminalValue(pos, ply) {
    return { score: inCheck(pos) ? -MATE_SCORE + ply : 0, pv: [], terminal: true, mateProven: true };
  }
  // A single legal submission disproves terminal status. Only reaching done
  // without a work/time interruption proves mate or stalemate.
  function probeTerminal(pos, ply) {
    if (!terminalCache.has(pos)) {
      tick('search');
      const legal = iterator(pos);
      try { terminalCache.set(pos, legal.next().done); }
      finally { legal.return?.(); }
    }
    return terminalCache.get(pos) ? terminalValue(pos, ply) : null;
  }
  function candidates(pos, ply) {
    if (ply === 0 && rootCandidates) return rootCandidates;
    if (candidateCache.has(pos)) return candidateCache.get(pos);
    const limit = ply === 0 ? candidateLimit : innerCandidateLimit;
    const legal = iterator(pos), items = [];
    let exhaustive = false;
    try {
      while (items.length < limit) {
        const next = legal.next();
        if (next.done) { exhaustive = true; break; }
        items.push(next.value);
        if (ply === 0 && bestAction === null) {
          // A budget fallback is explicitly unscored until inference succeeds.
          bestAction = next.value.moves; pv = [bestAction];
        }
      }
    } finally { legal.return?.(); }
    if (!exhaustive) candidateCaps++;
    terminalCache.set(pos, exhaustive && !items.length);
    const result = { items, exhaustive };
    // A WeakMap of candidate arrays still retains the entire tree transitively:
    // each cached parent owns the positions used as keys by its descendants.
    // Keep the root plus a bounded FIFO of inner expansions instead.
    if (ply === 0) rootCandidates = result;
    else if (maxCachedPositions) {
      if (candidateCache.size >= maxCachedPositions) candidateCache.delete(candidateCache.keys().next().value);
      candidateCache.set(pos, result);
    }
    return result;
  }
  async function infer(positions) {
    for (const unused of positions) tick('search');
    check(false);
    // Waiting for a model must remain cancellable even if its transport stalls.
    // The evaluator may finish later; Promise.race consumes its rejection and
    // no late result can update this search's caches or principal variation.
    let timer;
    const interrupted = new Promise((resolve, reject) => {
      const poll = () => {
        try { check(false); }
        catch (error) { reject(error); return; }
        timer = setTimeout(poll, Math.min(25, Math.max(1, deadline - performance.now())));
      };
      timer = setTimeout(poll, Math.min(25, Math.max(1, deadline - performance.now())));
    });
    let values;
    try {
      inferenceBatches++;
      values = await Promise.race([Promise.resolve().then(() => options.evaluateBatch(positions)), interrupted]);
    } finally { clearTimeout(timer); }
    check(false);
    if (!Array.isArray(values) || values.length !== positions.length || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Transformer evaluator must return one finite White-centipawn number per position.');
    }
    evaluations += values.length;
    positions.forEach((pos, index) => valueCache.set(pos, Math.max(-MATE_THRESHOLD + 1, Math.min(MATE_THRESHOLD - 1, values[index]))));
  }
  async function rank(items, ply, parentSign) {
    const pending = [];
    const ranked = items.map((candidate, index) => {
      selectiveDepth = Math.max(selectiveDepth, ply);
      const terminal = probeTerminal(candidate.position, ply);
      if (!terminal && !valueCache.has(candidate.position)) pending.push(candidate.position);
      return { ...candidate, terminal, index };
    });
    // The inference service accepts at most 128 positions per request even when
    // an advanced caller increases the root candidate cap above that value.
    for (let offset = 0; offset < pending.length; offset += 128) await infer(pending.slice(offset, offset + 128));
    for (const item of ranked) {
      item.value = item.terminal ? -item.terminal.score : valueCache.get(item.position) * parentSign;
    }
    return ranked.sort((a, b) => b.value - a.value || a.index - b.index);
  }
  async function search(pos, remaining, ply, alpha = -Infinity, beta = Infinity) {
    check(); tick('search');
    selectiveDepth = Math.max(selectiveDepth, ply);
    const generated = candidates(pos, ply);
    if (!generated.items.length) return terminalValue(pos, ply);
    const ranked = await rank(generated.items, ply + 1, sign(pos));
    // Reuse the last iteration's best turn for ordering only. It cannot change
    // candidate membership or exclude moves with a weak shallow model value.
    const preferred = preferredActions.get(pos);
    const preferredIndex = remaining > 1 ? ranked.findIndex(item => item.moves === preferred) : -1;
    if (preferredIndex > 0) ranked.unshift(...ranked.splice(preferredIndex, 1));
    let best = null;
    let searched = 0, allLossesProven = true;
    for (const candidate of ranked) {
      check(false);
      const child = candidate.terminal || (remaining === 1
        ? { score: -candidate.value, pv: [], mateProven: false }
        : await search(candidate.position, remaining - 1, ply + 1, -beta, -alpha));
      const result = { score: -child.score, pv: [candidate.moves, ...child.pv], mateProven: child.mateProven };
      searched++;
      allLossesProven &&= result.score < -MATE_THRESHOLD && result.mateProven;
      if (ply === 0) rootActionsSearched++;
      if (!best || result.score > best.score) {
        best = result;
        if (ply === 0) rootPartial = { ...result, bestAction: candidate.moves };
      }
      // A negative mate score is provisional until every legal alternative
      // loses. Do not tighten the window or cut off on it: clamping an
      // unproved losing mate after a cutoff would corrupt the returned bound.
      if (result.score >= -MATE_THRESHOLD) {
        alpha = Math.max(alpha, result.score);
        if (alpha >= beta && searched < ranked.length) { cutoffs++; break; }
      }
    }
    preferredActions.set(pos, best.pv[0]);
    if (Math.abs(best.score) > MATE_THRESHOLD) {
      // A winning mate needs one certified continuation; a losing mate needs
      // every legal alternative. A capped or cut-off tree cannot prove a loss.
      best.mateProven = best.score > 0 ? best.mateProven
        : generated.exhaustive && searched === ranked.length && allLossesProven;
      if (!best.mateProven) best.score = Math.sign(best.score) * (MATE_THRESHOLD - 1);
    }
    return best;
  }
  function snapshot() {
    const elapsedMs = Math.max(0, performance.now() - started);
    const whiteScore = score === null ? null : Math.round(score * rootSign);
    return {
      engine: 'transformer', bestAction, score: whiteScore, depth, nodes, searchNodes, generationNodes,
      qnodes: 0, ttHits: 0, qTtHits: 0, cutoffs, elapsedMs: Math.round(elapsedMs),
      searchingDepth, rootActionsSearched, selectiveDepth,
      nps: elapsedMs ? Math.round(nodes * 1000 / elapsedMs) : 0, pv, status, completed,
      stoppedReason, tableEntries: 0, cacheMemoryBytes: 0,
      searchPolicy: 'transformer-bounded-alpha-beta', candidateLimit, innerCandidateLimit,
      candidateCaps, candidateCacheEntries: candidateCache.size, evaluations, inferenceBatches, policyLeaves: 0, effectiveQuiescenceDepth: 0,
      mateProven, terminalProof: ['checkmate', 'stalemate'].includes(status) ? 'unrestricted-legal-exhaustion' : null,
      scoreType: score === null ? 'unavailable' : Math.abs(score) > MATE_THRESHOLD ? 'mate' : 'cp',
      mateIn: score !== null && Math.abs(score) > MATE_THRESHOLD ? Math.sign(whiteScore) * (MATE_SCORE - Math.abs(score)) : null,
      limits: { timeMs, maxDepth, maxNodes, candidateLimit, innerCandidateLimit, maxCachedPositions, quiescenceDepth: 0 },
    };
  }
  try {
    for (let currentDepth = 1; currentDepth <= maxDepth; currentDepth++) {
      searchingDepth = currentDepth; rootActionsSearched = 0; rootPartial = null;
      const result = await search(position, currentDepth, 0);
      score = result.score; pv = result.pv; bestAction = pv[0] || null;
      mateProven = Math.abs(score) > MATE_THRESHOLD && Boolean(result.mateProven);
      depth = result.terminal ? 0 : currentDepth; completed = true;
      status = result.terminal ? (score ? 'checkmate' : 'stalemate') : 'ok';
      lastProgress = performance.now(); options.onProgress?.(snapshot());
      check(false);
      if (result.terminal) return snapshot();
      if (result.mateProven && Math.abs(score) > MATE_THRESHOLD) { stoppedReason = 'mate'; break; }
    }
    stoppedReason ||= 'depth';
  } catch (error) {
    if (!(error instanceof SearchInterrupted)) throw error;
    if (!completed && rootPartial) {
      bestAction = rootPartial.bestAction; pv = rootPartial.pv;
      // Partial iterations cannot certify a losing mate over unsearched moves.
      score = rootPartial.score < -MATE_THRESHOLD ? -MATE_THRESHOLD + 1 : rootPartial.score;
      mateProven = Math.abs(score) > MATE_THRESHOLD && Boolean(rootPartial.mateProven);
    }
  }
  return snapshot();
}
