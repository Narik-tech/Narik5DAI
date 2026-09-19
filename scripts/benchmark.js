import { readFile } from 'node:fs/promises';
import { analyze } from '../src/search.js';
import { createPosition, formatAction, validateAction } from '../src/rules.js';

const timeMs = Number(process.env.BENCH_TIME_MS ?? 1000);
if (!Number.isFinite(timeMs) || timeMs < 1) throw new Error('BENCH_TIME_MS must be positive.');
const cases = [
  ['standard', { variant: 'standard' }],
  ['two timelines', { variant: 'two_timelines' }],
  ['opening', { pgn: await readFile(new URL('../examples/opening.5dpgn', import.meta.url), 'utf8') }],
  ['temporal attack', { pgn: await readFile(new URL('../examples/time-travel.5dpgn', import.meta.url), 'utf8') }],
];
const results = [];
for (const [name, setup] of cases) {
  const position = createPosition(setup);
  const result = analyze(position, { timeMs, maxDepth: 8, maxNodes: 1000000, quiescenceDepth: 2 });
  if (result.bestAction) validateAction(position, result.bestAction);
  results.push({
    name, depth: result.depth, nodes: result.nodes, nps: result.nps,
    ms: Math.round(result.elapsedMs), score: result.score, status: result.status,
    turn: result.bestAction ? formatAction(position, result.bestAction) : 'none',
  });
}
console.table(results);
console.log('Local throughput and legality smoke benchmark; this does not establish an Elo rating.');
