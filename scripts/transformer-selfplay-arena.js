import { createPosition, positionKey } from '../src/rules.js';
import { certifyTerminal, runGame, summarizeGames, summarizePairs } from './match.js';

const FINISHED = new Set(['A_WIN', 'B_WIN', 'DRAW']);

function integer(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}.`);
}

function thresholds(minPairs, promotionScore) {
  integer('minPairs', minPairs, 1, 10000);
  if (!Number.isFinite(promotionScore) || promotionScore < 0.5 || promotionScore > 1) {
    throw new Error('promotionScore must be between 0.5 and 1.');
  }
}

function certifiedFinish(game) {
  if (game?.valid !== true || !FINISHED.has(game.result)) return false;
  const certificate = game.certificate;
  if (certificate?.verified !== true || certificate.terminal !== true) return false;
  if (game.result === 'DRAW') return certificate.status === 'stalemate' && certificate.winnerColor === null;
  if (certificate.status !== 'checkmate' || ![0, 1].includes(certificate.winnerColor)) return false;
  const winner = certificate.winnerColor === game.aColor ? 'A' : 'B';
  return game.result === `${winner}_WIN`;
}

function pairDetails(pair, games) {
  if (!Array.isArray(pair.gameIndices) || pair.gameIndices.length !== 2 ||
      pair.gameIndices.some(index => !Number.isInteger(index) || index < 0 || index >= games.length)) {
    return { complete: false, eligible: false, reason: 'invalid-pair-games' };
  }
  const played = pair.gameIndices.map(index => games[index]);
  const summary = summarizeGames(played);
  if (played[0].aColor !== 0 || played[1].aColor !== 1 || typeof pair.initialKey !== 'string' ||
      !pair.initialKey || played.some(game => game.initialKey !== pair.initialKey)) {
    return { complete: false, eligible: false, reason: 'unpaired-starts', summary };
  }
  const complete = played.every(certifiedFinish);
  if (!complete) return { complete: false, eligible: false, reason: 'unfinished-or-invalid-pair', summary };
  if (played.some(game => !Array.isArray(game.moves) || game.moves.length < 1 || game.plies !== game.moves.length)) {
    return { complete: true, eligible: false, reason: 'no-meaningful-play', summary };
  }
  const engines = new Set(played.flatMap(game => game.moves.map(move => move.engine)));
  if (!engines.has('A') || !engines.has('B')) {
    return { complete: true, eligible: false, reason: 'both-engines-must-play', summary };
  }
  return { complete: true, eligible: true, reason: null, summary };
}

/** A small acceptance gate, not an Elo estimate or a statistical strength proof. */
export function decidePromotion({ pairs = [], games = [], minPairs = 4, promotionScore = 0.55 } = {}) {
  thresholds(minPairs, promotionScore);
  if (!Array.isArray(pairs) || !Array.isArray(games)) throw new Error('pairs and games must be arrays.');
  const seen = new Set(), eligible = [];
  let duplicatePairs = 0, excludedPairs = 0;
  for (const pair of pairs) {
    const details = pairDetails(pair, games);
    if (!details.eligible) { excludedPairs++; continue; }
    if (seen.has(pair.initialKey)) { duplicatePairs++; continue; }
    seen.add(pair.initialKey);
    eligible.push({ ...pair, ...details, complete: true });
  }
  const score = summarizePairs(eligible);
  const invalidGames = games.filter(game => game?.valid !== true).length;
  let reason;
  if (invalidGames) reason = 'invalid-games';
  else if (score.pairs < minPairs) reason = 'insufficient-complete-distinct-pairs';
  else if (score.aScore <= 0.5) reason = 'no-winning-margin';
  else if (score.aScore < promotionScore) reason = 'below-promotion-score';
  else reason = 'promotion-threshold-met';
  return { promote: reason === 'promotion-threshold-met', reason, minPairs, promotionScore,
    candidate: 'A', incumbent: 'B', candidateScore: score.aScore,
    candidatePoints: score.aPoints, incumbentPoints: score.bPoints,
    eligiblePairs: score.pairs, eligibleGames: score.pairs * 2, invalidGames, excludedPairs, duplicatePairs,
    requirement: 'At least minPairs distinct starting positions, two valid certified games with played turns per pair, and candidate score above 50% and at least promotionScore. Any invalid game vetoes promotion.',
    limitation: 'This small deterministic paired arena is an operational acceptance gate, not independent statistical evidence of general strength or an Elo estimate.' };
}

/** Run candidate=A and incumbent=B on identical starts with colors swapped. */
export async function evaluateCandidate({ candidate, incumbent, suite, pairs: requestedPairs = 4, seed = 1,
  maxPlies = 80, maxNodes = 20000, maxDepth = 2, timeMs = 3000, terminalWork = 20000,
  minPairs = 4, promotionScore = 0.55, shouldStop, onGame } = {}) {
  if (typeof candidate !== 'function' || typeof incumbent !== 'function') throw new Error('candidate and incumbent must be analyze callbacks.');
  if (!suite || !Array.isArray(suite.cases) || !suite.cases.length) throw new Error('suite needs nonempty cases.');
  if (shouldStop !== undefined && typeof shouldStop !== 'function') throw new Error('shouldStop must be a function.');
  if (onGame !== undefined && typeof onGame !== 'function') throw new Error('onGame must be a function.');
  thresholds(minPairs, promotionScore);
  integer('pairs', requestedPairs, 1, 10000);
  integer('seed', seed, 0, 0xffffffff);
  for (const [name, value, minimum, maximum] of [
    ['maxPlies', maxPlies, 0, 10000], ['maxNodes', maxNodes, 0, 1e9], ['maxDepth', maxDepth, 1, 64],
    ['timeMs', timeMs, 1, 3600000], ['terminalWork', terminalWork, 0, 1e9],
  ]) integer(name, value, minimum, maximum);
  const limits = { maxPlies, maxNodes, maxDepth, timeMs, terminalWork, quiescenceDepth: 0 };
  let cancellation = null;
  function checkStopped() {
    if (!cancellation && shouldStop?.()) {
      cancellation = new Error('Transformer self-play arena cancelled.');
      cancellation.name = 'AbortError';
    }
    if (cancellation) throw cancellation;
  }
  const wrap = engine => async (position, gameLimits) => {
    checkStopped();
    let timer;
    const interrupted = new Promise((resolve, reject) => {
      timer = setInterval(() => { try { checkStopped(); } catch (error) { reject(error); } }, 25);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => engine(position, { ...gameLimits, engine: 'transformer', shouldStop: () => Boolean(shouldStop?.() || cancellation) })),
        interrupted,
      ]);
      if (result?.stoppedReason === 'cancelled') {
        cancellation = new Error('Transformer self-play arena cancelled by an engine.');
        cancellation.name = 'AbortError';
      }
      checkStopped();
      return result;
    } catch (error) {
      if (error?.name === 'AbortError') cancellation = error;
      throw error;
    } finally { clearInterval(timer); }
  };
  const engineA = wrap(candidate), engineB = wrap(incumbent);
  const games = [], paired = [], scheduledCases = [], skippedCases = [], seen = new Set();
  const offset = seed % suite.cases.length;
  for (let index = 0; index < suite.cases.length && paired.length < requestedPairs; index++) {
    checkStopped();
    const fixture = suite.cases[(offset + index) % suite.cases.length];
    if (!fixture || typeof fixture.id !== 'string') throw new Error('Each arena case needs a string id.');
    if (fixture.file && !fixture.position) throw new Error('Load file-based arena fixtures with loadMatchSuite before evaluating.');
    const position = fixture.position ? structuredClone(fixture.position) : createPosition({ pgn: fixture.pgn, variant: fixture.variant });
    const initialKey = positionKey(position);
    if (seen.has(initialKey)) { skippedCases.push({ caseId: fixture.id, reason: 'duplicate-position' }); continue; }
    seen.add(initialKey);
    const certificate = certifyTerminal(position, limits);
    checkStopped();
    if (!certificate.verified || certificate.terminal) {
      skippedCases.push({ caseId: fixture.id, reason: certificate.terminal ? 'terminal-start' : 'uncertified-start', certificate });
      continue;
    }
    scheduledCases.push(fixture.id);
    const gameIndices = [];
    for (const aColor of [0, 1]) {
      checkStopped();
      const game = { caseId: fixture.id, category: fixture.category ?? null, seed,
        ...await runGame({ position, engineA, engineB, aColor, ...limits }) };
      checkStopped(); // runGame converts engine exceptions into invalid results.
      gameIndices.push(games.length);
      games.push(game);
      if (onGame) await onGame(structuredClone(game));
      checkStopped();
    }
    const pair = { caseId: fixture.id, seed, initialKey, gameIndices };
    paired.push({ ...pair, ...pairDetails(pair, games) });
  }
  checkStopped();
  const decision = decidePromotion({ pairs: paired, games, minPairs, promotionScore });
  return { engines: { A: 'candidate', B: 'incumbent' }, suiteVersion: suite.version ?? null,
    seed, requestedPairs, limits, scheduledCases, skippedCases,
    games, pairs: paired, summary: { ...summarizeGames(games), totalPairs: paired.length,
      completePairs: paired.filter(pair => pair.complete).length,
      eligiblePairs: decision.eligiblePairs, uniqueStartingPositions: new Set(paired.map(pair => pair.initialKey)).size,
      completedPairScore: summarizePairs(paired.map(pair => ({ ...pair, complete: pair.eligible }))) }, decision,
    methodology: 'Deterministic case rotation by seed; distinct full-history starting positions only. Candidate A and incumbent B use equal limits and swapped colors. Only independently certified checkmate or stalemate finishes games. Unfinished games are not draws and neither evaluation scores nor ply limits adjudicate results. Only complete, valid, played pairs enter promotion scoring; any invalid game blocks promotion. Repeated arena selection can overfit this suite; no statistical strength guarantee.' };
}
