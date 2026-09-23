import { raw } from './rules.js';

// Centipawn values are deliberately conservative, hand-tuned starting values.
// A queen's extra dimensional freedom is worth substantially more than in 2D.
export const PIECE_VALUES = Object.freeze([0, 100, 355, 340, 550, 1150, 0, 900, 140, 370, 0, 450, 350]);
const ROYAL_TYPES = new Set([6, 10]);
const KNIGHT_STEPS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const AXES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
// Keep variant-piece geometry in sync with the rules library. These profiles
// describe attacks only: king safety and complete-turn legality remain search's
// responsibility, and pawns/brawns have separate directional capture rules.
const TEMPORAL_MOVEMENT = Array.from({ length: PIECE_VALUES.length }, (_, type) => ({
  steps: new Set(raw.pieceFuncs.movePos(type * 2).filter(v => v[0] || v[1]).map(v => v.join(','))),
  rays: new Set(raw.pieceFuncs.moveVecs(type * 2).filter(v => v[0] || v[1]).map(v => v.join(','))),
}));

export function pieceValue(piece) {
  return PIECE_VALUES[Math.ceil(Math.abs(piece || 0) / 2)] || 0;
}

function owner(piece) { return Math.abs(piece) % 2; }
function signFor(color) { return color === 0 ? 1 : -1; }
function timelineCoordinate(index, even) {
  const value = index % 2 ? -(index + 1) / 2 : index / 2;
  return even && value > 0 ? value - 1 : value;
}

function temporalAttack(board, attacker, king, even) {
  // Half-turn boards of different colors cannot be connected by a move.
  if ((attacker.t - king.t) % 2) return false;
  const delta = [
    timelineCoordinate(king.l, even) - timelineCoordinate(attacker.l, even),
    (king.t - attacker.t) / 2,
    king.r - attacker.r, king.f - attacker.f,
  ];
  const movement = TEMPORAL_MOVEMENT[attacker.type];
  if (movement.steps.has(delta.join(','))) return true;
  const distance = Math.max(...delta.map(Math.abs));
  if (!distance || !movement.rays.size) return false;
  const step = delta.map(value => value / distance);
  if (!movement.rays.has(step.join(','))) return false;
  for (let offset = 1; offset < distance; offset++) {
    const line = raw.pieceFuncs.timelineMove(attacker.l, step[0] * offset, even);
    const square = board[line]?.[attacker.t + step[1] * offset * 2]?.[attacker.r + step[2] * offset]?.[attacker.f + step[3] * offset];
    // Rays stop at occupied squares and at gaps in the multiverse. Leapers,
    // checked above, do not require intermediate boards or squares to exist.
    if (square !== 0) return false;
  }
  return true;
}

function spatialActivity(board, r, f, type, color) {
  const steps = type === 3 ? KNIGHT_STEPS : type === 2 ? DIAGONALS : type === 4 ? AXES
    : type === 5 || type === 7 || ROYAL_TYPES.has(type) || type === 9 ? [...AXES, ...DIAGONALS] : [];
  const slider = [2, 4, 5, 7, 10].includes(type);
  let count = 0;
  for (const [dr, df] of steps) {
    let y = r + dr, x = f + df;
    while (board[y]?.[x] !== undefined) {
      const target = board[y][x];
      if (!target || owner(target) !== color) count++;
      if (target || !slider) break;
      y += dr; x += df;
    }
  }
  return count;
}

// Evaluate only the frontier of each timeline, never add up historical copies.
// Inactive timelines retain some value because they can reactivate later.
export function evaluateDetailed(position) {
  const { board } = position;
  const active = new Set(raw.boardFuncs.active(board));
  const even = raw.boardFuncs.isEvenTimeline(board);
  const totals = { material: 0, activity: 0, kingSafety: 0, temporal: 0, timelines: 0 };
  const royals = [], attackers = [], frontier = [];
  let totalWeight = 0;
  const worstKing = [0, 0];
  for (let l = 0; l < board.length; l++) {
    const timeline = board[l];
    if (!timeline?.length) continue;
    const t = timeline.length - 1, squares = timeline[t];
    if (!squares) continue;
    const weight = active.has(l) ? 1 : 0.2;
    totalWeight += weight;
    let material = 0, activity = 0, kingSafety = 0;
    const pawns = [[], []], pieces = [], kings = [];
    let phase = 0;
    for (let r = 0; r < squares.length; r++) {
      for (let f = 0; f < squares[r].length; f++) {
        const piece = squares[r][f];
        if (!piece) continue;
        const type = Math.ceil(Math.abs(piece) / 2), color = owner(piece), sign = signFor(color);
        const entry = { l, t, r, f, piece, type, color, weight };
        pieces.push(entry);
        material += sign * pieceValue(piece);
        if ([2, 3, 4, 5, 7].includes(type)) phase += pieceValue(piece);
        if (type === 1 || type === 8) pawns[color].push(entry);
        if (ROYAL_TYPES.has(type)) { kings.push(entry); royals.push(entry); }
        if (type > 1 && type !== 8) attackers.push(entry);
      }
    }
    const middleGame = Math.min(1, phase / 6000);
    for (const entry of pieces) {
      const { r, f, type, color, piece } = entry, sign = signFor(color);
      const rank = color === 0 ? r : squares.length - 1 - r;
      const center = (squares.length - 1) / 2;
      const centrality = Math.max(0, 4 - (Math.abs(r - center) + Math.abs(f - (squares[r].length - 1) / 2)) / 2);
      if (type === 1 || type === 8) {
        activity += sign * (rank * 7 + Math.max(0, rank - 3) ** 2 * 7 + centrality * 3);
        const sameFile = pawns[color].filter(p => p.f === f).length;
        if (sameFile > 1) activity -= sign * 9;
        if (!pawns[color].some(p => Math.abs(p.f - f) === 1)) activity -= sign * 9;
        if (!pawns[1 - color].some(p => Math.abs(p.f - f) <= 1 && (color === 0 ? p.r > r : p.r < r))) {
          activity += sign * (8 + rank * rank * 2);
        }
      } else if (!ROYAL_TYPES.has(type)) {
        const mobility = spatialActivity(squares, r, f, type, color);
        const centralWeight = type === 3 ? 11 : type === 2 ? 6 : 3;
        activity += sign * (mobility * (type === 5 ? 2 : 4) + centrality * centralWeight);
        if (piece < 0 && [2, 3].includes(type)) activity -= sign * 12 * middleGame;
        if (type === 4 && !pawns[color].some(p => p.f === f)) activity += sign * 14;
      } else {
        let shield = 0, nearbyEnemies = 0;
        const forward = color === 0 ? 1 : -1;
        for (const df of [-1, 0, 1]) {
          const p = squares[r + forward]?.[f + df];
          if (p && owner(p) === color && [1, 8].includes(Math.ceil(Math.abs(p) / 2))) shield++;
        }
        for (const enemy of pieces) {
          if (enemy.color !== color && enemy.type !== 1 && Math.max(Math.abs(enemy.r - r), Math.abs(enemy.f - f)) <= 3) nearbyEnemies++;
        }
        const risk = Math.max(0, (3 - shield) * 12 * middleGame + nearbyEnemies * 8 - (rank === 0 && (f <= 2 || f >= squares[r].length - 2) ? 15 : 0));
        kingSafety -= sign * risk;
        activity += sign * centrality * 10 * (1 - middleGame);
        if (active.has(l)) worstKing[color] = Math.max(worstKing[color], risk);
      }
    }
    totals.material += weight * material;
    totals.activity += weight * activity;
    totals.kingSafety += weight * kingSafety;
    frontier.push({ l, t, weight, material });
    // Sample historical royal squares for potential time attacks. Historical
    // copies contribute pressure only, never additional material.
    for (let past = t - 2, sampled = 0; past >= 0 && sampled < 6; past -= 2, sampled++) {
      const snapshot = timeline[past];
      if (!snapshot) continue;
      for (let r = 0; r < snapshot.length; r++) for (let f = 0; f < snapshot[r].length; f++) {
        const piece = snapshot[r][f], type = Math.ceil(Math.abs(piece || 0) / 2);
        if (ROYAL_TYPES.has(type)) royals.push({ l, t: past, r, f, color: owner(piece), weight: weight * 0.65 });
      }
    }
  }
  if (!totalWeight) return { ...totals, total: 0 };
  for (const key of ['material', 'activity', 'kingSafety']) totals[key] /= totalWeight;
  // One weak king can lose an otherwise healthy multiverse; averaging alone
  // would hide that weakness as more timelines are created.
  totals.kingSafety += (worstKing[1] - worstKing[0]) * 0.45;

  // Reward unobstructed temporal attacks, including those by royal and fairy
  // pieces. This remains potential pressure, not a complete-turn check test.
  const pressure = [0, 0];
  for (const attacker of attackers) {
    let best = 0;
    for (const king of royals) {
      if (king.color === attacker.color || (king.l === attacker.l && king.t === attacker.t)) continue;
      if (temporalAttack(board, attacker, king, even)) best = Math.max(best, 20 * Math.min(attacker.weight, king.weight));
    }
    pressure[attacker.color] += best;
  }
  totals.temporal = Math.max(-100, Math.min(100, pressure[0] - pressure[1]));
  // Additional boards require defending additional kings. Penalize a frontier
  // material weakness that averaging would otherwise conceal.
  const activeFrontier = frontier.filter(b => active.has(b.l));
  if (activeFrontier.length > 1) {
    const low = Math.min(...activeFrontier.map(b => b.material));
    const high = Math.max(...activeFrontier.map(b => b.material));
    totals.timelines = (Math.min(0, low) + Math.max(0, high)) * 0.12;
  }
  const total = Math.round(Object.values(totals).reduce((a, b) => a + b, 0));
  return { ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v)])), total };
}

/** Positive values favor White. Mate scores are assigned by search only. */
export function evaluate(position) { return evaluateDetailed(position).total; }
