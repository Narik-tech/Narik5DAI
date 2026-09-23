import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyze } from '../src/search.js';
import { raw, applyMove, createPosition, formatAction, generateActions, inCheck, positionKey, validateAction } from '../src/rules.js';

const fixtureRoot = new URL('../examples/tactics/', import.meta.url);

export async function loadTactics() {
  const suite = JSON.parse(await readFile(new URL('suite.json', fixtureRoot), 'utf8'));
  const cases = await Promise.all(suite.cases.map(async fixture => ({
    ...fixture, position: createPosition({ pgn: await readFile(new URL(fixture.file, fixtureRoot), 'utf8') }),
  })));
  return { ...suite, cases };
}

// Independently enumerate without the generator's performance shortcuts. This
// checks the terminal certificate, not a second copy of the search score.
function hasLegalReply(position) {
  let work = 0;
  const iterator = generateActions(position, {
    pruneUnsafe: false, cacheMoves: false,
    tick() { if (++work > 1_000_000) throw new Error('Terminal verification exceeded its work limit.'); },
  });
  try { return !iterator.next().done; }
  finally { iterator.return(); }
}

function verifyForcedMate(position, whiteMateDistance) {
  let work = 0;
  const winner = whiteMateDistance > 0 ? 0 : 1;
  function visit(current, remaining) {
    const winnerMoves = current.action % 2 === winner;
    let hasAction = false;
    for (const candidate of generateActions(current, {
      pruneUnsafe: false, cacheMoves: false,
      tick() { if (++work > 1_000_000) throw new Error('Mate verification exceeded its work limit.'); },
    })) {
      hasAction = true;
      if (remaining <= 0) return false;
      const wins = visit(candidate.position, remaining - 1);
      if (winnerMoves && wins) return true;
      if (!winnerMoves && !wins) return false;
    }
    if (!hasAction) return !winnerMoves && inCheck(current);
    return !winnerMoves;
  }
  return visit(position, Math.abs(whiteMateDistance));
}

export function assessTactic(fixture, result, originalKey = positionKey(fixture.position)) {
  const { position, expected } = fixture;
  const failures = [], errors = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  let after, verifiedMate = false;
  function validateSearchedAction(current, action) {
    const next = validateAction(current, action);
    if (result.searchPolicy === 'present-spatial') {
      for (const move of action) {
        const [from, to] = move;
        if (from[0] === to[0] && from[1] === to[1] && !raw.boardFuncs.present(current.board, current.action).includes(from[0])) {
          throw new Error('Search recommended an ordinary move on an optional board.');
        }
        current = applyMove(current, move);
      }
    }
    return next;
  }
  try {
    if (positionKey(position) !== originalKey) throw new Error('Search changed the input position.');
    if (result.bestAction) after = validateSearchedAction(position, result.bestAction);
    if (result.pv.length && JSON.stringify(result.pv[0]) !== JSON.stringify(result.bestAction)) throw new Error('PV does not begin with the best action.');
    let current = position;
    for (const action of result.pv) current = validateSearchedAction(current, action);
    if (result.nodes !== result.searchNodes + result.generationNodes) throw new Error('Work counters do not sum to total nodes.');
    if (result.nodes > result.limits.maxNodes) throw new Error('Search exceeded its work limit.');
    if (expected.startsInCheck !== undefined && inCheck(position) !== expected.startsInCheck) throw new Error('Fixture has an incorrect starting check assertion.');
    if (result.status === 'checkmate' || result.status === 'stalemate') {
      if (result.bestAction !== null || hasLegalReply(position)) throw new Error('False terminal result: a legal turn exists.');
      if (inCheck(position) !== (result.status === 'checkmate')) throw new Error('Terminal check classification is incorrect.');
    }
    if (expected.mateIn !== undefined && result.scoreType === 'mate' && result.mateIn === expected.mateIn && after) {
      const rootWinner = position.action % 2 === (expected.mateIn > 0 ? 0 : 1);
      verifiedMate = Math.abs(expected.mateIn) === 1 && rootWinner
        ? inCheck(after) && !hasLegalReply(after)
        : verifyForcedMate(position, expected.mateIn);
      if (!verifiedMate) throw new Error('Claimed forced mate has no complete-turn certificate.');
    }
  } catch (error) { errors.push(error.message); }
  const resultKey = after ? positionKey(after) : null;
  const expectedKey = action => positionKey(validateAction(position, action));
  require(result.completed, 'No search iteration completed.');
  if (expected.status) require(result.status === expected.status, `Expected ${expected.status}.`);
  else require(Boolean(result.bestAction), 'No legal best action returned.');
  if (expected.action) require(resultKey === expectedKey(expected.action), 'Expected tactical action was not selected.');
  if (expected.allowedActions) require(expected.allowedActions.some(action => expectedKey(action) === resultKey), 'Neither king may remain on the attacked file.');
  if (expected.forbiddenMoves) require(!result.bestAction?.some(move => expected.forbiddenMoves.some(bad => JSON.stringify(move) === JSON.stringify(bad))), 'Selected the poisoned capture.');
  if (expected.minDepth) require(result.depth >= expected.minDepth, `Requires completed depth ${expected.minDepth}.`);
  if (expected.minQuiescenceDepth) require(result.effectiveQuiescenceDepth >= expected.minQuiescenceDepth, `Requires completed quiescence depth ${expected.minQuiescenceDepth}.`);
  if (expected.scoreSign !== undefined) require(result.score !== null && Math.sign(result.score) === expected.scoreSign, 'Unexpected White-perspective score sign.');
  if (expected.mateIn !== undefined) require(result.scoreType === 'mate' && result.mateIn === expected.mateIn && verifiedMate, `Expected independently verified mate score ${expected.mateIn}.`);
  if (expected.temporal) require(result.bestAction?.some(([from, to]) => from[0] !== to[0] || from[1] !== to[1]), 'Expected a temporal move.');
  return { solved: failures.length === 0 && errors.length === 0, valid: errors.length === 0, failures, errors, verifiedMate };
}

function deterministicRecord(result) {
  return JSON.stringify([
    result.bestAction, result.pv, result.score, result.depth, result.effectiveQuiescenceDepth,
    result.status, result.completed, result.stoppedReason, result.nodes, result.searchNodes,
    result.generationNodes, result.qnodes, result.cutoffs, result.ttHits, result.qTtHits ?? 0,
    result.searchPolicy, result.policyLeaves ?? 0,
  ]);
}

export async function runStrengthSuite({ budgets = [1000, 10000, 50000], timeMs = 30000, repeat = 1, caseIds, engine = analyze, maxDepth, quiescenceDepth } = {}) {
  const suite = await loadTactics();
  const selected = caseIds ? suite.cases.filter(fixture => caseIds.includes(fixture.id)) : suite.cases;
  if (caseIds?.some(id => !selected.some(fixture => fixture.id === id))) throw new Error('Unknown case id. See examples/tactics/suite.json.');
  const results = [];
  for (const budget of budgets) {
    for (const fixture of selected) {
      const limits = { ...fixture.limits, maxNodes: budget, timeMs };
      if (maxDepth !== undefined) limits.maxDepth = maxDepth;
      if (quiescenceDepth !== undefined) limits.quiescenceDepth = quiescenceDepth;
      const originalKey = positionKey(fixture.position);
      let first, firstAssessment, deterministic = repeat > 1 ? true : null, timeLimited = false;
      const elapsed = [], errors = new Set(), failures = new Set();
      let solved = true;
      for (let attempt = 0; attempt < repeat; attempt++) {
        const result = engine(fixture.position, limits);
        const assessment = assessTactic(fixture, result, originalKey);
        if (!first) { first = result; firstAssessment = assessment; }
        else if (deterministicRecord(first) !== deterministicRecord(result)) deterministic = false;
        solved &&= assessment.solved;
        timeLimited ||= result.stoppedReason === 'time';
        elapsed.push(result.elapsedMs);
        for (const message of assessment.errors) errors.add(message);
        for (const message of assessment.failures) failures.add(message);
      }
      // A time-interrupted trial is not a deterministic work-budget comparison.
      if (timeLimited) deterministic = null;
      if (deterministic === false) errors.add('Repeated work-budget runs produced different search results.');
      results.push({
        id: fixture.id, category: fixture.category, budget, repeat, limits,
        solved: solved && errors.size === 0, valid: errors.size === 0,
        deterministic, timeLimited, verifiedMate: firstAssessment.verifiedMate,
        depth: first.depth, quiescenceDepth: first.effectiveQuiescenceDepth,
        nodes: first.nodes, searchNodes: first.searchNodes, generationNodes: first.generationNodes,
        qnodes: first.qnodes, ttHits: first.ttHits, qTtHits: first.qTtHits ?? 0, cutoffs: first.cutoffs,
        searchPolicy: first.searchPolicy ?? null, policyLeaves: first.policyLeaves ?? 0,
        status: first.status, completed: first.completed, stoppedReason: first.stoppedReason,
        score: first.score, scoreType: first.scoreType, mateIn: first.mateIn,
        action: first.bestAction, turn: first.bestAction ? formatAction(fixture.position, first.bestAction) : null,
        elapsedMs: elapsed, pvLength: first.pv.length,
        failures: [...failures], errors: [...errors],
      });
    }
  }
  return {
    suiteVersion: suite.version, description: suite.description,
    summary: budgets.map(budget => {
      const rows = results.filter(row => row.budget === budget);
      return { budget, solved: rows.filter(row => row.solved).length, total: rows.length,
        invalid: rows.filter(row => !row.valid).length, timeLimited: rows.filter(row => row.timeLimited).length };
    }),
    results,
  };
}

const help = `Usage: node scripts/strength.js [options]
  --nodes N,N       Deterministic work budgets (default: 1000,10000,50000)
  --case ID,ID      Run selected fixture ids
  --repeat N        Repeat each trial and check deterministic results (default: 1)
  --time-ms N       Per-search wall-clock safety cap (default: 30000)
  --depth N        Override fixture full-turn depth
  --qdepth N       Override fixture capture-search depth
  --engine FILE    Alternate local search.js exporting analyze (for comparisons)
  --json           Emit only machine-readable JSON
  --strict         Exit unsuccessfully for any unsolved case
  --help           Show this help
Fixture horizons are explicit in examples/tactics/suite.json. Warmup results
below a fixture's required horizon do not count as solved. No Elo is inferred.`;

function parseArguments(args) {
  const parsed = { json: false, strict: false, options: {} };
  const integer = (value, name, min, max) => {
    if (!/^\d+$/.test(value ?? '') || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return Number(value);
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') parsed.help = true;
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--strict') parsed.strict = true;
    else if (flag === '--nodes') {
      const value = args[++i];
      if (!value) throw new Error('--nodes requires comma-separated budgets.');
      parsed.options.budgets = [...new Set(value.split(',').map(item => integer(item, flag, 0, 1_000_000_000)))];
    } else if (flag === '--case') {
      const value = args[++i];
      if (!value) throw new Error('--case requires fixture ids.');
      parsed.options.caseIds = value.split(',');
    } else if (flag === '--repeat') parsed.options.repeat = integer(args[++i], flag, 1, 100);
    else if (flag === '--time-ms') parsed.options.timeMs = integer(args[++i], flag, 1, 3_600_000);
    else if (flag === '--depth') parsed.options.maxDepth = integer(args[++i], flag, 1, 64);
    else if (flag === '--qdepth') parsed.options.quiescenceDepth = integer(args[++i], flag, 0, 8);
    else if (flag === '--engine') {
      parsed.enginePath = args[++i];
      if (!parsed.enginePath) throw new Error('--engine requires a local module path.');
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) console.log(help);
    else {
      if (parsed.enginePath) {
        parsed.options.engine = (await import(pathToFileURL(resolve(parsed.enginePath)))).analyze;
        if (typeof parsed.options.engine !== 'function') throw new Error('Alternate engine must export analyze.');
      }
      const report = await runStrengthSuite(parsed.options);
      report.engine = parsed.enginePath || 'src/search.js';
      if (parsed.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.table(report.results.map(row => ({
          case: row.id, budget: row.budget, solved: row.solved, depth: row.depth,
          q: row.quiescenceDepth, nodes: row.nodes, ms: row.elapsedMs[0],
          reason: row.stoppedReason, turn: row.turn || row.status,
          ...(row.repeat > 1 ? { deterministic: row.deterministic } : {}),
        })));
        console.table(report.summary);
        for (const row of report.results.filter(row => !row.solved)) console.log(`${row.id} @ ${row.budget}: ${[...row.errors, ...row.failures].join(' ')}`);
        console.log(report.description);
      }
      if (report.results.some(row => !row.valid || (parsed.strict && !row.solved))) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
