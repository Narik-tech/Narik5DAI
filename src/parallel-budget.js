// Shared counters are deliberately small: position histories and transposition
// tables remain private to each search thread.
export const CANCEL = 0, NODES = 1, STOP_ITERATION = 2;
export const SEARCH_NODES = 3, GENERATION_NODES = 4, QNODES = 5;
export const clock = () => performance.timeOrigin + performance.now();

export function claimNode(shared, maxNodes, kind) {
  let value = Atomics.load(shared, NODES);
  while (value < maxNodes) {
    const previous = Atomics.compareExchange(shared, NODES, value, value + 1);
    if (previous === value) {
      Atomics.add(shared, kind === 'generation' ? GENERATION_NODES : SEARCH_NODES, 1);
      if (kind === 'quiescence') Atomics.add(shared, QNODES, 1);
      return true;
    }
    value = previous;
  }
  return false;
}

// Search the first sibling with a full window. Later siblings use a scout
// window, then repeat any improving probe with the original full window.
// A bound sent to a worker may be stale, but never stronger than the current
// root bound, so completing that job still gives a valid result.
export function searchCandidate(session, position, request, first = false) {
  const { alpha, beta, remaining, horizon } = request;
  const task = { position, remaining: remaining - 1, horizon, ply: 1 };
  let child = session.subtree({ ...task, alpha: first ? -beta : -alpha - 1, beta: -alpha });
  if (!first && -child.score > alpha && -child.score < beta) {
    child = session.subtree({ ...task, alpha: -beta, beta: -alpha });
  }
  return child;
}
