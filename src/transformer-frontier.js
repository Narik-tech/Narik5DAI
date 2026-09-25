// Scores are White-relative; all moves at one depth have the same mover.
// A cached shallow value becomes True only when the scheduler selects it.
export function rankDepths(levels, rootSign) {
  return levels.flatMap((nodes, depth) => {
    if (!depth || !nodes?.length) return [];
    const side = depth % 2 ? rootSign : -rootSign;
    const value = node => node.trueScore === null ? node.candidateScore : node.value;
    const ranked = nodes.slice().sort((a, b) => side * (value(b) - value(a)) || a.index - b.index);
    const firstCandidate = ranked.findIndex(node => node.trueScore === null);
    return [{ depth, ranked, searchedMoves: firstCandidate < 0 ? Infinity : firstCandidate,
      candidate: firstCandidate < 0 ? null : ranked[firstCandidate] }];
  });
}

export function chooseWork(rankings, { maxDepth }) {
  const active = rankings.filter(level => level.depth <= maxDepth);
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
