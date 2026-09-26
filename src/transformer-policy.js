import { applyMove, pseudoMoves, raw, validateAction } from './rules.js';

export const COMPONENT_POLICY_VERSION = 1;
export const MAX_POLICY_MOVES = 16384;

/** Teacher targets use the same required-or-temporal component mask as search.
 * Every target is a component of a validated complete teacher turn. Pseudo-legal
 * alternatives remain in the mask: legality of a full compound turn still
 * belongs to rules/search, not the policy head.
 */
export function componentPolicyTargets(position, action) {
  if (!Array.isArray(action) || action.length === 0 || action.length > 256) return [];
  validateAction(position, action);
  const examples = [];
  let current = position;
  for (const [componentIndex, selected] of action.entries()) {
    const present = raw.boardFuncs.present(current.board, current.action);
    const moves = pseudoMoves(current).filter(([from, to]) => present.includes(from[0])
      || from[0] !== to[0] || from[1] !== to[1]);
    const target = moves.findIndex(move => raw.validateFuncs.compareMove(move, selected) === 0);
    if (target >= 0 && moves.length <= MAX_POLICY_MOVES) {
      examples.push({ ...(current === position ? {} : { position: current }), moves, target, componentIndex });
    }
    current = applyMove(current, selected);
  }
  return examples;
}
