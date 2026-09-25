import { applyMove, canSubmit, createPositionKeyCache, formatAction, generateActions, generateActionsAsync, inCheck, raw } from './rules.js';
import { canDeepen, chooseWork, DYNAMIC_DEPTH_THRESHOLD, rankDepths } from './transformer-frontier.js';

export const MATE_SCORE = 100_000;
const MATE_THRESHOLD = MATE_SCORE - 1000;
const sign = position => position.action % 2 === 0 ? 1 : -1;
const finite = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Number(value))) : fallback;
class SearchInterrupted extends Error {}
class TerminalProbeDeferred extends Error {}
const SHALLOW_TERMINAL_WORK = 64;
const PROGRESS_INTERVAL_MS = 100;
const DISPLAY_RANK_LIMIT = 10;

/**
 * Neural value search over complete legal submissions. Distinct partial-move
 * successors are scored in batches to assemble the strongest components first,
 * before the full-turn candidate cap. Candidate values average their component
 * scores. A persistent ranked frontier schedules true evaluations and selective
 * expansion across depths, backing up only evaluated continuations.
 * Candidate caps still make this selective, not exhaustive full-rule minimax.
 * Values are always White centipawns.
 * The evaluator is required: no classical evaluation replaces a missing model.
 */
export async function analyze(position, options = {}) {
  if (typeof options.evaluateBatch !== 'function') throw new Error('Transformer search requires evaluateBatch.');
  const started = performance.now();
  const timeMs = finite(options.timeMs, 3000, 0, 3_600_000);
  const maxDepth = Math.floor(finite(options.maxDepth, 4, 0, 64));
  const dynamicDepth = maxDepth === 0;
  let currentMaxDepth = dynamicDepth ? 1 : maxDepth;
  const maxNodes = Math.floor(finite(options.maxNodes, 200_000, 0, 1_000_000_000));
  const candidateLimit = Math.floor(finite(options.candidateLimit, 64, 1, 256));
  // The same position must see the same candidate set when it becomes the
  // root. Advanced callers may still opt into a different reply cap, accepting
  // that asymmetry even though both caps now follow neural component ordering.
  const innerCandidateLimit = Math.floor(finite(options.innerCandidateLimit, candidateLimit, 1, 256));
  const maxCachedPositions = Math.floor(finite(options.maxCachedPositions, 128, 0, 512));
  const deadline = options.unlimitedTime === true ? Infinity : started + timeMs, rootSign = sign(position);
  const keyPosition = createPositionKeyCache();
  const candidateCache = new Map(), terminalCache = new WeakMap(), valueCache = new WeakMap();
  const levels = [];
  const root = { position, depth: 0, children: null, parent: null };
  let nextIndex = 0, trueEvaluations = 0;
  let rootCandidates = null;
  let nodes = 0, searchNodes = 0, generationNodes = 0, evaluations = 0, inferenceBatches = 0;
  let depth = 0, searchingDepth = 0, selectiveDepth = 0, rootActionsSearched = 0;
  let bestAction = null, pv = [], score = null, rootFallback = null;
  let completed = false, status = 'incomplete', stoppedReason = null;
  let mateProven = false;
  let candidateCaps = 0, lastProgress = started;
  const notationCache = new WeakMap();

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
    reportProgress();
  }
  function reportProgress(force = false) {
    if (!options.onProgress || bestAction === null) return;
    const now = performance.now();
    if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) return;
    lastProgress = now;
    options.onProgress(snapshot());
  }
  function retainRootCandidate(moves, next, terminal = null) {
    if (completed) return;
    const value = terminal ? -terminal.score : valueCache.get(next) * rootSign;
    if (Number.isFinite(value) && (!rootFallback || value > rootFallback.score)) {
      rootFallback = { bestAction: moves, pv: [moves], score: value, mateProven: Boolean(terminal?.mateProven) };
    }
  }
  async function* iterator(pos, ply) {
    const generated = new Set();
    // Scores belong to a resulting history, not a move's coordinates: playing
    // the same temporal move after another component can create a new branch.
    // Keep this cache only while assembling this position's candidate turns.
    const partials = new Map();
    const prefixScores = new Map([[JSON.stringify([]), { sum: 0, count: 0 }]]);
    let hasOptionalMoves = false;
    const generationOptions = { tick, keyPosition, skipOptionalSpatial: false };
    async function orderMoves(current, moves, prefix, requiredOnly = false) {
      // Time travel can change the present during a complete turn. Both
      // future active boards and inactive boards are optional source boards.
      const present = new Set(raw.boardFuncs.present(current.board, current.action));
      const pending = [], ordered = [];
      const rootTurns = ply === 0 ? new Map() : null;
      for (const [index, move] of moves.entries()) {
        const required = present.has(move[0][0]);
        hasOptionalMoves ||= !required;
        // The unrestricted pass scores optional continuations when needed.
        // In particular, do no speculative work after a required-only turn
        // is already submittable and every remaining source is optional.
        if (requiredOnly && !required) continue;
        tick();
        const partial = applyMove(current, move), complete = canSubmit(partial);
        // A partial turn retains the mover; only the rules engine may decide
        // that a successor can also be evaluated as a completed submission.
        const successor = complete ? { ...partial, action: partial.action + 1 } : partial;
        const key = keyPosition(successor);
        let entry = partials.get(key);
        if (!entry) {
          // Candidate construction must stay shallow. A difficult mate proof
          // belongs to the selected True evaluation, not every component that
          // might later be discarded by the candidate cap.
          const terminal = complete ? probeTerminal(successor, ply + 1, SHALLOW_TERMINAL_WORK) : null;
          entry = { position: successor, terminal, complete };
          partials.set(key, entry);
          if (!terminal) pending.push(successor);
        }
        ordered.push({ move, entry, required, index });
        if (rootTurns && entry.complete) {
          // canSubmit certified the entire prefix plus this component. Keep
          // completed batch values even if a later batch or generator tick
          // interrupts before the complete candidate is yielded.
          const turn = [...prefix, move];
          rootTurns.set(entry.position, turn);
          retainRootCandidate(turn, entry.position, entry.terminal);
        }
      }
      // Score each distinct alternative eligible in this pass before selecting
      // components, even when the full-turn cap is one. Reuse scores across
      // commuting prefixes and passes, within service batch limits.
      for (let offset = 0; offset < pending.length; offset += 128) {
        const batch = pending.slice(offset, offset + 128);
        await infer(batch);
        if (rootTurns) for (const next of batch) {
          const turn = rootTurns.get(next);
          if (turn) retainRootCandidate(turn, next);
        }
      }
      for (const { entry } of ordered) {
        entry.value ??= entry.terminal ? -entry.terminal.score : valueCache.get(entry.position) * sign(current);
      }
      const prefixScore = prefixScores.get(JSON.stringify(prefix));
      for (const { move, entry } of ordered) {
        prefixScores.set(JSON.stringify([...prefix, move]), {
          sum: prefixScore.sum + entry.value * sign(current), count: prefixScore.count + 1,
        });
      }
      return ordered.sort((a, b) => Number(b.required) - Number(a.required) || b.entry.value - a.entry.value || a.index - b.index)
        .map(item => item.move);
    }
    async function reuseEvaluation(candidate) {
      const entry = partials.get(keyPosition(candidate.position));
      if (entry?.complete) {
        // A bounded probe can leave terminal status unknown. Never turn an
        // unfinished proof into a cached nonterminal result.
        if (terminalCache.has(entry.position)) terminalCache.set(candidate.position, terminalCache.get(entry.position));
        if (!entry.terminal) valueCache.set(candidate.position, valueCache.get(entry.position));
      }
      const components = prefixScores.get(JSON.stringify(candidate.moves));
      if (components?.count) candidate.candidateScore = components.sum / components.count;
      else {
        // Submitting an already-complete turn has no components to average.
        const terminal = probeTerminal(candidate.position, ply + 1, SHALLOW_TERMINAL_WORK);
        if (!terminal && !valueCache.has(candidate.position)) await infer([candidate.position]);
        candidate.candidateScore = terminal ? terminal.score * sign(candidate.position) : valueCache.get(candidate.position);
      }
      return candidate;
    }
    // Sorting component moves alone still lets depth-first optional extensions
    // fill the candidate cap before the next required-board alternative.
    // Generate every required-only submission before considering those turns.
    for await (const candidate of generateActionsAsync(pos, { ...generationOptions,
      orderMoves: (current, moves, prefix) => orderMoves(current, moves, prefix, true),
    })) {
      generated.add(keyPosition(candidate.position));
      yield await reuseEvaluation(candidate);
    }
    if (!hasOptionalMoves) return;
    // Replay unrestricted generation to preserve optional-before-required
    // sequences whose ordering changes a temporal arrival into a branch.
    for await (const candidate of generateActionsAsync(pos, { ...generationOptions, orderMoves })) {
      if (!generated.has(keyPosition(candidate.position))) yield await reuseEvaluation(candidate);
    }
  }
  function terminalValue(pos, ply) {
    return { score: inCheck(pos) ? -MATE_SCORE + ply : 0, pv: [], terminal: true, mateProven: true };
  }
  // A single legal submission disproves terminal status. Only reaching done
  // without a work/time interruption proves mate or stalemate.
  function probeTerminal(pos, ply, maxWork = Infinity) {
    if (!terminalCache.has(pos)) {
      tick('search');
      selectiveDepth = Math.max(selectiveDepth, ply);
      let work = 0;
      const legal = generateActions(pos, { tick: () => {
        if (work >= maxWork) throw new TerminalProbeDeferred();
        work++; tick();
      }, keyPosition, skipOptionalSpatial: false });
      try { terminalCache.set(pos, legal.next().done); }
      catch (error) { if (!(error instanceof TerminalProbeDeferred)) throw error; }
      finally { legal.return?.(); }
    }
    return terminalCache.get(pos) ? terminalValue(pos, ply) : null;
  }
  async function candidates(pos, ply) {
    if (ply === 0 && rootCandidates) return rootCandidates;
    if (candidateCache.has(pos)) return candidateCache.get(pos);
    const limit = ply === 0 ? candidateLimit : innerCandidateLimit;
    // Preserve a legal fallback before the first awaited component evaluation.
    // This unrestricted probe also proves root terminals without model calls.
    if (ply === 0 && !terminalCache.has(pos)) {
      const fallback = generateActions(pos, { tick, keyPosition, skipOptionalSpatial: false });
      try {
        const first = fallback.next();
        terminalCache.set(pos, first.done);
        if (!first.done) { bestAction = first.value.moves; pv = [bestAction]; }
      } finally { fallback.return?.(); }
    }
    const legal = iterator(pos, ply), items = [];
    let exhaustive = false;
    try {
      while (items.length < limit && !terminalCache.get(pos)) {
        const next = await legal.next();
        if (next.done) { exhaustive = true; break; }
        items.push(next.value);
        if (ply === 0 && bestAction === null) {
          // A budget fallback is explicitly unscored until inference succeeds.
          bestAction = next.value.moves; pv = [bestAction];
        }
        if (ply === 0 && !completed) {
          // A yielded candidate is a complete legal turn. Retain its known
          // value now: assembling a later candidate can exhaust the budget.
          // Partial component values must never become playable fallbacks.
          const candidate = next.value;
          const terminal = terminalCache.get(candidate.position) ? terminalValue(candidate.position, 1) : null;
          retainRootCandidate(candidate.moves, candidate.position, terminal);
        }
      }
      if (terminalCache.get(pos)) exhaustive = true;
    } finally { await legal.return?.(); }
    if (!exhaustive) candidateCaps++;
    terminalCache.set(pos, exhaustive && !items.length);
    const result = { items, exhaustive };
    // Bound the auxiliary expansion cache independently of the retained search
    // tree. The time/work budgets, rather than this cache limit, bound the tree.
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
        try { check(false); reportProgress(); }
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
  async function expand(node) {
    searchingDepth = node.depth + 1;
    const generated = await candidates(node.position, node.depth);
    node.exhaustive = generated.exhaustive;
    node.children = generated.items.map(candidate => ({
      ...candidate, parent: node, depth: node.depth + 1, index: nextIndex++,
      trueScore: null, value: null, children: null, terminal: null,
      mateProven: false, best: null,
    }));
    if (node.children.length) {
      (levels[node.depth + 1] ??= []).push(...node.children);
      selectiveDepth = Math.max(selectiveDepth, node.depth + 1);
    }
  }
  function backup(node) {
    for (let current = node; current; current = current.parent) {
      const side = sign(current.position);
      const evaluated = current.children?.filter(child => child.trueScore !== null) ?? [];
      const best = evaluated.reduce((best, child) =>
        !best || child.value * side > best.value * side ? child : best, null);
      current.best = best;
      if (!best) {
        current.value = current.trueScore;
        current.mateProven = Boolean(current.terminal?.mateProven);
        continue;
      }
      current.value = best.value;
      current.mateProven = false;
      if (Math.abs(current.value) > MATE_THRESHOLD) {
        current.mateProven = current.value * side > 0 ? best.mateProven
          : current.exhaustive && evaluated.length === current.children.length
            && evaluated.every(child => child.value * side < -MATE_THRESHOLD && child.mateProven);
        if (!current.mateProven) current.value = Math.sign(current.value) * (MATE_THRESHOLD - 1);
      }
    }
  }
  function publishRoot() {
    if (!root.best) return;
    score = root.value * rootSign;
    mateProven = Math.abs(score) > MATE_THRESHOLD && root.mateProven;
    pv = [];
    for (let node = root.best; node; node = node.best) pv.push(node.moves);
    bestAction = pv[0];
    completed = true;
    status = 'ok';
  }
  async function evaluateCandidate(node) {
    searchingDepth = node.depth;
    tick('search');
    const terminal = probeTerminal(node.position, node.depth);
    // The final component often already evaluated this exact submitted state.
    // Reusing it avoids a duplicate model call without changing scheduling.
    if (!terminal && !valueCache.has(node.position)) await infer([node.position]);
    check(false);
    node.terminal = terminal;
    node.trueScore = terminal ? terminal.score * sign(node.position) : valueCache.get(node.position);
    node.value = node.trueScore;
    node.mateProven = Boolean(terminal?.mateProven);
    trueEvaluations++;
    if (node.depth === 1) rootActionsSearched++;
    const previousDepth = depth;
    depth = Math.max(depth, node.depth);
    backup(node);
    publishRoot();
    reportProgress(depth > previousDepth);
  }
  function notationFor(node) {
    if (!notationCache.has(node)) {
      notationCache.set(node, formatAction(node.parent.position, node.moves) || 'Submit turn');
    }
    return notationCache.get(node);
  }
  function displayEntry(node, index) {
    const isTrue = node.trueScore !== null;
    const value = isTrue ? node.value : node.candidateScore;
    const provenMate = isTrue && node.mateProven && Math.abs(value) > MATE_THRESHOLD;
    const line = [];
    // Retain the route from the root: entries at the same depth can belong to
    // different branches, so their move notation alone is not enough context.
    for (let current = node; current.parent; current = current.parent) line.push(notationFor(current));
    line.reverse();
    for (let current = node.best; current; current = current.best) line.push(notationFor(current));
    return {
      id: node.index, rank: index + 1, evaluationType: isTrue ? 'true' : 'candidate',
      score: Math.round(value), scoreType: provenMate ? 'mate' : 'cp',
      mateIn: provenMate ? Math.sign(value) * (MATE_SCORE - Math.abs(value)) : null,
      notation: notationFor(node), line, expanded: node.children !== null,
    };
  }
  function snapshot() {
    const elapsedMs = Math.max(0, performance.now() - started);
    const whiteScore = score === null ? null : Math.round(score * rootSign);
    const rankings = rankDepths(levels, rootSign);
    const commonPrefix = Math.min(...rankings.map(level => level.searchedMoves));
    return {
      engine: 'transformer', bestAction, score: whiteScore, depth, nodes, searchNodes, generationNodes,
      qnodes: 0, ttHits: 0, qTtHits: 0, cutoffs: 0, elapsedMs: Math.round(elapsedMs),
      searchingDepth, rootActionsSearched, selectiveDepth,
      depthMode: dynamicDepth ? 'dynamic' : 'fixed', currentMaxDepth,
      dynamicDepthThreshold: dynamicDepth ? DYNAMIC_DEPTH_THRESHOLD : null,
      nps: elapsedMs ? Math.round(nodes * 1000 / elapsedMs) : 0, pv, status, completed,
      stoppedReason, tableEntries: 0, cacheMemoryBytes: 0,
      searchPolicy: 'transformer-ranked-depth', candidateLimit, innerCandidateLimit,
      trueEvaluations, pvDepth: pv.length,
      progressIntervalMs: PROGRESS_INTERVAL_MS,
      expansionRank: Number.isFinite(commonPrefix) ? commonPrefix : null,
      rankings: rankings.map(level => ({
        depth: level.depth, side: (level.depth % 2 ? rootSign : -rootSign) > 0 ? 'white' : 'black',
        total: level.ranked.length,
        searchedMoves: Number.isFinite(level.searchedMoves) ? level.searchedMoves : null,
        entries: level.ranked.slice(0, DISPLAY_RANK_LIMIT).map(displayEntry),
      })),
      depthStats: rankings.map(level => ({
        depth: level.depth, candidates: level.ranked.filter(node => node.trueScore === null).length,
        trueEvaluations: level.ranked.filter(node => node.trueScore !== null).length,
        searchedMoves: Number.isFinite(level.searchedMoves) ? level.searchedMoves : null,
        topCandidateRank: level.candidate ? level.searchedMoves + 1 : null,
      })),
      candidateCaps, candidateCacheEntries: candidateCache.size, evaluations, inferenceBatches, policyLeaves: 0, effectiveQuiescenceDepth: 0,
      mateProven, terminalProof: ['checkmate', 'stalemate'].includes(status) ? 'unrestricted-legal-exhaustion' : null,
      scoreType: score === null ? 'unavailable' : Math.abs(score) > MATE_THRESHOLD ? 'mate' : 'cp',
      mateIn: score !== null && Math.abs(score) > MATE_THRESHOLD ? Math.sign(whiteScore) * (MATE_SCORE - Math.abs(score)) : null,
      limits: { timeMs, maxDepth, maxNodes, candidateLimit, innerCandidateLimit, maxCachedPositions, quiescenceDepth: 0 },
    };
  }
  try {
    await expand(root);
    if (!root.children.length) {
      const result = terminalValue(position, 0);
      score = result.score; mateProven = Math.abs(score) > MATE_THRESHOLD && result.mateProven; completed = true;
      bestAction = null; pv = [];
      status = score ? 'checkmate' : 'stalemate';
      stoppedReason = 'terminal';
    } else {
      while (true) {
        check();
        const rankings = rankDepths(levels, rootSign);
        if (dynamicDepth && canDeepen(rankings, currentMaxDepth)) {
          currentMaxDepth++;
          reportProgress(true);
          check();
        }
        const work = chooseWork(rankings, { maxDepth: currentMaxDepth });
        if (!work) { stoppedReason = depth === currentMaxDepth ? 'depth' : 'frontier'; break; }
        if (work.kind === 'expand') await expand(work.node);
        else await evaluateCandidate(work.node);
        check(false);
        if (mateProven) { stoppedReason = 'mate'; break; }
      }
    }
  } catch (error) {
    if (!(error instanceof SearchInterrupted)) throw error;
    if (!completed && rootFallback) {
      bestAction = rootFallback.bestAction; pv = rootFallback.pv;
      // A partial root cannot certify a loss over unsearched alternatives.
      score = rootFallback.score < -MATE_THRESHOLD ? -MATE_THRESHOLD + 1 : rootFallback.score;
      mateProven = Math.abs(score) > MATE_THRESHOLD && Boolean(rootFallback.mateProven);
    }
  }
  return snapshot();
}
