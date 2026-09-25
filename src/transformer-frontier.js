// Scores are White-relative; all moves at one depth have the same mover.
// A cached shallow value becomes True only when the scheduler selects it.
export const DYNAMIC_DEPTH_THRESHOLD = 20;

function describeDepth(depth, ranked) {
  const firstCandidate = ranked.findIndex(node => node.trueScore === null);
  return { depth, ranked, searchedMoves: firstCandidate < 0 ? Infinity : firstCandidate,
    candidate: firstCandidate < 0 ? null : ranked[firstCandidate] };
}

export function rankDepths(levels, rootSign) {
  const ranksByDepth = [];
  return levels.flatMap((nodes, depth) => {
    if (!depth || !nodes?.length) return [];
    const side = depth % 2 ? rootSign : -rootSign;
    const value = node => node.trueScore === null ? node.candidateScore : node.value;
    // Favor continuations of the current higher-ranked parent before comparing
    // their own scores. Rebuilding these ranks propagates backed-up changes
    // through every later depth, while depth one retains score-only ordering.
    const parentRank = node => ranksByDepth[depth - 1]?.get(node.parent) ?? Infinity;
    const ranked = nodes.slice().sort((a, b) => parentRank(a) - parentRank(b)
      || side * (value(b) - value(a)) || a.index - b.index);
    ranksByDepth[depth] = new Map(ranked.map((node, index) => [node, index]));
    return [describeDepth(depth, ranked)];
  });
}

export function canDeepen(rankings, maxDepth) {
  if (maxDepth >= 64) return false;
  const active = rankings.filter(level => level.depth <= maxDepth);
  // A new ceiling must acquire its own candidates before it can advance again.
  // Short exhausted depths report Infinity and need no extra evaluations.
  return active.some(level => level.depth === maxDepth && level.ranked.length > 0)
    && active.every(level => level.searchedMoves >= DYNAMIC_DEPTH_THRESHOLD);
}

export function chooseWork(rankings, { maxDepth }) {
  const active = rankings.filter(level => level.depth <= maxDepth);
  const continuations = new Map();
  function continuation(node) {
    if (!continuations.has(node)) {
      const next = node.best ? continuation(node.best) : { length: 0, tip: node };
      continuations.set(node, { length: next.length + 1, tip: next.tip });
    }
    return continuations.get(node);
  }
  const shortLines = [];
  for (const level of active) {
    for (let rank = 1; rank < level.ranked.length; rank++) {
      const node = level.ranked[rank], line = continuation(node);
      // Include the route from the root, matching "Full continuation" in the UI.
      const length = node.depth - 1 + line.length;
      const previousLength = level.depth - 1 + continuation(level.ranked[rank - 1]).length;
      if (length * 2 >= previousLength || length >= maxDepth
        || node.mateProven || line.tip.terminal || line.tip.mateProven) continue;
      shortLines.push({ node, rank });
    }
  }
  shortLines.sort((a, b) => a.rank - b.rank || a.node.depth - b.node.depth);
  for (const { node } of shortLines) {
    const branch = new Set(), pending = [node];
    while (pending.length) {
      const current = pending.pop();
      branch.add(current);
      if (current.depth < maxDepth && current.children) pending.push(...current.children);
    }
    const scoped = active.flatMap(level => {
      const ranked = level.ranked.filter(entry => branch.has(entry));
      return ranked.length ? [describeDepth(level.depth, ranked)] : [];
    });
    // Recompute the prefix inside this branch so a stronger parent elsewhere
    // cannot starve it. Use normal scheduling locally, without nested overrides.
    const work = chooseRankedWork(scoped, maxDepth);
    if (work) return work;
  }
  return chooseRankedWork(active, maxDepth);
}

function chooseRankedWork(active, maxDepth) {
  // The shortest common evaluated prefix determines the currently eligible
  // ranks. Exhausted depths have no candidate left to delay another expansion.
  const commonPrefix = Math.min(...active.map(level => level.searchedMoves));
  if (commonPrefix > 0) {
    let best = null;
    for (const level of active) {
      if (level.depth >= maxDepth) continue;
      for (let index = 0; index < Math.min(commonPrefix, level.ranked.length); index++) {
        const node = level.ranked[index];
        if (node.trueScore === null || node.children !== null || node.terminal) continue;
        if (!best || index < best.rank || (index === best.rank && level.depth < best.node.depth)) {
          best = { node, rank: index };
        }
        break;
      }
    }
    if (best) return { kind: 'expand', node: best.node };
  }
  const next = active.filter(level => level.candidate).sort((a, b) =>
    a.searchedMoves - b.searchedMoves || a.depth - b.depth)[0];
  return next ? { kind: 'evaluate', node: next.candidate } : null;
}
