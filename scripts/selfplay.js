import { analyze } from '../src/search.js';
import { createPosition, validateAction, formatAction } from '../src/rules.js';

// Reproducible engine-vs-engine diagnostic. Never adjudicate a capped game as mate.
const plies = Number(process.env.SELFPLAY_PLIES ?? 20);
const timeMs = Number(process.env.SELFPLAY_TIME_MS ?? 250);
if (!Number.isInteger(plies) || plies < 1 || plies > 1000 || !Number.isFinite(timeMs) || timeMs < 1) {
  throw new Error('Invalid SELFPLAY_PLIES or SELFPLAY_TIME_MS.');
}
let position = createPosition();
console.log('[Board "Standard"]\n[Mode "5D"]\n');
for (let ply = 0; ply < plies; ply++) {
  const result = analyze(position, { timeMs, maxDepth: 6, maxNodes: 100000, quiescenceDepth: 1 });
  if (!Array.isArray(result.bestAction)) {
    console.error(`Stopped: ${result.status} after ${ply} turns.`);
    break;
  }
  console.log(`${position.action % 2 === 0 ? `${Math.floor(position.action / 2) + 1}.` : '/'} ${formatAction(position, result.bestAction)}`);
  position = validateAction(position, result.bestAction);
  console.error(`turn ${ply + 1}: depth ${result.depth}, white score ${result.score}, ${result.nodes} work nodes`);
  if (ply === plies - 1) console.error('Stopped at requested turn limit; game is unfinished.');
}
