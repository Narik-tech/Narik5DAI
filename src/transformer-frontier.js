// Scores are White-relative; displayed depth rows retain parent-first ordering.
// This threshold now describes root contenders, not a quota at every depth.
export const DYNAMIC_DEPTH_THRESHOLD = 3;
export const INITIAL_REPLY_COVERAGE = 2;
const EXPLORATION_INTERVAL = 8;
const CLOSE_SCORE = 150;

const scoreOf = node => node.trueScore === null ? node.candidateScore : node.value;
const visitsOf = node => Number.isFinite(node.visits) ? node.visits : 0;
const resolved = node => Boolean(node.terminal || node.mateProven);

function describeDepth(depth, ranked) {
  const firstCandidate = ranked.findIndex(node => node.trueScore === null);
  return { depth, ranked, searchedMoves: firstCandidate < 0 ? Infinity : firstCandidate,
    candidate: firstCandidate < 0 ? null : ranked[firstCandidate] };
}

export function rankDepths(levels, rootSign = 1) {
  const ranksByDepth = [];
  return levels.flatMap((nodes, depth) => {
    if (!depth || !nodes?.length) return [];
    const side = depth % 2 ? rootSign : -rootSign;
    const parentRank = node => ranksByDepth[depth - 1]?.get(node.parent) ?? Infinity;
    const ranked = nodes.slice().sort((a, b) => parentRank(a) - parentRank(b)
      || side * (scoreOf(b) - scoreOf(a)) || a.index - b.index);
    ranksByDepth[depth] = new Map(ranked.map((node, index) => [node, index]));
    return [describeDepth(depth, ranked)];
  });
}

function searchTree(rankings, root, rootSign) {
  // Small standalone callers can omit root. Real search always passes it, so
  // pending root generation remains visible even before a depth row exists.
  const first = rankings.toSorted((a, b) => a.depth - b.depth).find(level => level.ranked.length);
  root ??= first?.ranked[0]?.parent ?? (first && { depth: first.depth - 1, children: first.ranked });
  const childrenByParent = new Map();
  for (const level of rankings) for (const node of level.ranked) {
    if (!node.parent) continue;
    if (!childrenByParent.has(node.parent)) childrenByParent.set(node.parent, []);
    childrenByParent.get(node.parent).push(node);
  }
  const childCache = new Map();
  function children(node) {
    if (!childCache.has(node)) {
      const list = childrenByParent.get(node) ?? node.children ?? [];
      const side = node.depth % 2 ? -rootSign : rootSign;
      childCache.set(node, list.slice().sort((a, b) => side * (scoreOf(b) - scoreOf(a)) || a.index - b.index));
    }
    return childCache.get(node);
  }
  return { root, children };
}

function lineTip(node) {
  const seen = new Set();
  while (node.best && !seen.has(node)) {
    seen.add(node);
    node = node.best;
  }
  return node;
}

export function canDeepen(rankings, maxDepth, { root, rootSign = 1 } = {}) {
  if (maxDepth >= 64) return false;
  const tree = searchTree(rankings, root, rootSign);
  if (!tree.root) return false;
  const contenders = tree.children(tree.root).slice(0, DYNAMIC_DEPTH_THRESHOLD);
  if (!contenders.length || contenders.some(node => node.trueScore === null)) return false;
  let liveCeiling = false;
  for (const contender of contenders) {
    if (resolved(contender)) continue;
    if (maxDepth > contender.depth) {
      const replies = tree.children(contender);
      if (!replies.length || replies.slice(0, INITIAL_REPLY_COVERAGE).some(node => node.trueScore === null)) return false;
      // A temporarily short generator is not yet evidence of reply coverage.
      if (replies.length < INITIAL_REPLY_COVERAGE && contender.canWiden) return false;
    }
    const tip = lineTip(contender);
    if (tip.trueScore === null) return false;
    if (tip.depth < maxDepth && !resolved(tip)) return false;
    liveCeiling ||= tip.depth >= maxDepth && !resolved(tip);
  }
  // Resolved lines need no deeper ceiling; at least one live continuation must
  // actually reach it. Breadth elsewhere does not hold up a forcing line.
  return liveCeiling;
}

export function chooseWork(rankings, { maxDepth, root, rootSign = 1, canExpand, canEvaluate } = {}) {
  const tree = searchTree(rankings, root, rootSign);
  root = tree.root;
  if (!root) return null;
  const expandable = node => node.depth < maxDepth || Boolean(canExpand?.(node));
  const evaluable = node => !canEvaluate || canEvaluate(node);
  const widenable = node => expandable(node) && node.canWiden && !node.generationDone && !resolved(node);
  const contenders = tree.children(root).slice(0, DYNAMIC_DEPTH_THRESHOLD);

  // Compare a few plausible root moves before spending the budget on one PV.
  // Then search two currently strongest opponent replies for each contender.
  // This coverage is branch-local and remains valid after scores reorder.
  for (const contender of contenders) {
    if (contender.trueScore === null && evaluable(contender)) return { kind: 'evaluate', node: contender };
  }
  for (const contender of contenders) {
    if (resolved(contender) || !expandable(contender) || contender.trueScore === null) continue;
    if (contender.children === null) return { kind: 'expand', node: contender };
    const replies = tree.children(contender);
    for (const reply of replies.slice(0, INITIAL_REPLY_COVERAGE)) {
      if (reply.trueScore === null && evaluable(reply)) return { kind: 'evaluate', node: reply };
    }
    if (replies.length < INITIAL_REPLY_COVERAGE && widenable(contender)) return { kind: 'widen', node: contender };
  }

  // One eighth of work is explicit exploration. Following the least visited
  // available branch at each split prevents a badly scored move from starving.
  // A separate quarter of work can repair competitive continuation deficits.
  const workCount = visitsOf(root);
  const explore = workCount > 0 && workCount % EXPLORATION_INTERVAL === 0;
  const catchUp = !explore && workCount % 4 === 2;
  const memo = new Map();
  function select(node, allowCatchUp = true) {
    const key = allowCatchUp ? node : null;
    if (key && memo.has(key)) return memo.get(key);
    let result = null;
    if (node !== root && node.trueScore === null) {
      if (evaluable(node)) result = { kind: 'evaluate', node };
    } else if (!resolved(node) && expandable(node)) {
      if (node.children === null) result = { kind: 'expand', node };
      else {
        const children = tree.children(node);
        // Width grows approximately with sqrt(work): 8 -> 16 after 24
        // operations, 32 after 120, 64 after 504. Deepening gets time between
        // batches, while an exhausted frontier widens immediately (depth 1 too).
        const desiredWidth = 8 * Math.sqrt(1 + visitsOf(node) / 8);
        if (widenable(node) && children.length * 2 <= desiredWidth) result = { kind: 'widen', node };
        else {
          const side = node.depth % 2 ? -rootSign : rootSign;
          const bestScore = children.length ? scoreOf(children[0]) * side : 0;
          let shortestAbove = Infinity;
          const available = [];
          for (const [rank, child] of children.entries()) {
            const tip = lineTip(child), length = tip.depth;
            // Preserve suppression throughout demoted branches: a branch
            // already deeper than a stronger alternative has no catch-up claim.
            const suppressed = !allowCatchUp || length > shortestAbove;
            const gap = Math.max(0, bestScore - scoreOf(child) * side);
            const instability = child.trueScore === null ? 0 : Math.abs(child.value - child.trueScore);
            const competitive = gap <= CLOSE_SCORE || child.forcing || instability >= CLOSE_SCORE;
            const deficit = rank > 0 && !resolved(tip) && (shortestAbove - length >= 2
              || shortestAbove >= maxDepth && length < maxDepth);
            const work = select(child, !suppressed);
            if (work) available.push({ child, work, rank,
              catchUp: catchUp && !suppressed && competitive && deficit,
              // A stable rank prior keeps tied evaluations selective: a
              // visit bonus alone degenerates into breadth-first search in
              // large equal-score trees. Explicit exploration supplies fairness.
              priority: -gap / 200 - rank * 0.25 + 0.1 / Math.sqrt(visitsOf(child) + 1)
                + (child.trueScore === null ? 0.1 : 0) + (child.forcing ? 0.35 : 0)
                + Math.min(400, instability) / 400,
            });
            shortestAbove = Math.min(shortestAbove, length);
          }
          available.sort((a, b) => explore
            ? visitsOf(a.child) - visitsOf(b.child) || a.rank - b.rank
            : Number(b.catchUp) - Number(a.catchUp) || b.priority - a.priority || a.rank - b.rank);
          result = available[0]?.work ?? (widenable(node) ? { kind: 'widen', node } : null);
        }
      }
    }
    if (key) memo.set(key, result);
    return result;
  }
  return select(root);
}
