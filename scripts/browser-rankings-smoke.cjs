// Optional Playwright regression check using an isolated local game server.
// Search progress is mocked so live ranking changes and delayed polls are exact;
// Play best submits the mocked final legal turn through the real rules endpoints.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate, description, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(20);
  }
}
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

(async () => {
  const { createApp } = await import('../src/server.js');
  const { createPosition, formatAction, generateActions } = await import('../src/rules.js');
  const start = createPosition();
  const actions = [...generateActions(start)];
  const first = actions.find(action => formatAction(start, action.moves) === '(0T1)e4');
  const second = actions.find(action => formatAction(start, action.moves) === '(0T1)d4');
  assert(first && second, 'The live leaders must be distinct legal root turns.');
  const rootChoices = [first, second, ...actions.filter(action => action !== first && action !== second)].slice(0, 10);
  const replyChoices = [...generateActions(second.position)].slice(0, 10);
  const firstNotation = formatAction(start, first.moves), secondNotation = formatAction(start, second.moves);
  const server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser;
  const gates = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [], jobs = new Map(), played = [];
    let currentJob, nextJob = 1;
    page.on('pageerror', error => errors.push(error.message));

    function snapshot(version, done = false) {
      const leader = version ? second : first;
      const candidateLeads = version === 3;
      const rootOrder = version && !candidateLeads ? [rootChoices[1], rootChoices[0], ...rootChoices.slice(2)] : rootChoices;
      const entries = rootOrder.map((candidate, index) => ({
        id: rootChoices.indexOf(candidate) + 1, rank: index + 1,
        evaluationType: candidateLeads ? (index === 1 ? 'true' : 'candidate')
          : index === 0 || (version > 0 && index === 1) ? 'true' : 'candidate',
        score: candidateLeads && index < 2 ? (index === 0 ? 310 : 235)
          : index === 0 ? (version ? 235 : 120) : 100 - index * 15,
        scoreType: 'cp', mateIn: null, notation: formatAction(start, candidate.moves),
        line: [formatAction(start, candidate.moves)], expanded: index === 0,
      }));
      const replies = replyChoices.map((candidate, index) => ({
        id: 100 + index, rank: index + 1,
        evaluationType: index === 0 || (version > 1 && index === 1) ? 'true' : 'candidate',
        score: -240 + index * 20 + version, scoreType: 'cp', mateIn: null,
        notation: formatAction(second.position, candidate.moves),
        line: [secondNotation, formatAction(second.position, candidate.moves)], expanded: index === 0,
      }));
      const rankings = [
        { depth: 1, side: 'white', total: 20, searchedMoves: version ? 2 : 1, entries },
        { depth: 2, side: 'black', total: 24, searchedMoves: version > 1 ? 2 : 1, entries: replies },
        { depth: 3, side: 'white', total: 1, searchedMoves: null, entries: [{
          id: 200, rank: 1, evaluationType: 'true', score: 300, scoreType: 'cp', mateIn: null,
          notation: '(0T2)Nf3', line: [secondNotation, replies[0].notation, '(0T2)Nf3'], expanded: false,
        }] },
      ];
      if (version > 1) rankings.push({ depth: 4, side: 'black', total: 1, searchedMoves: 0, entries: [{
        id: 300, rank: 1, evaluationType: 'candidate', score: -150, scoreType: 'cp', mateIn: null,
        notation: '(0T2)Nf6', line: [secondNotation, replies[0].notation, '(0T2)Nf3', '(0T2)Nf6'], expanded: false,
      }] });
      return {
        engine: 'transformer', searchPolicy: 'transformer-ranked-depth', bestAction: leader.moves,
        notation: formatAction(start, leader.moves), score: version ? 235 : 120, scoreType: 'cp', mateIn: null,
        pv: [leader.moves], pvNotation: [formatAction(start, leader.moves)], pvDepth: 1,
        depth: version > 1 ? 4 : 3, searchingDepth: version > 1 ? 4 : 3, selectiveDepth: version > 1 ? 4 : 3,
        status: 'ok', completed: true, stoppedReason: done ? 'depth' : null,
        nodes: 1000 + version * 100, searchNodes: 100, generationNodes: 900 + version * 100,
        trueEvaluations: 12 + version, evaluations: 120 + version * 10, inferenceBatches: 10,
        rootActionsSearched: version ? 2 : 1, elapsedMs: 100 + version * 100, nps: 10000,
        expansionRank: 1, rankings, candidateLimit: 64, innerCandidateLimit: 64,
        depthStats: rankings.map(row => ({ depth: row.depth, candidates: row.entries.filter(entry => entry.evaluationType === 'candidate').length,
          trueEvaluations: row.entries.filter(entry => entry.evaluationType === 'true').length, searchedMoves: row.searchedMoves })),
        limits: { timeMs: 10000, maxDepth: 16, maxNodes: 2000000, candidateLimit: 64, innerCandidateLimit: 64 },
        model: { device: 'mock', config: { max_tokens: 4096 } },
      };
    }

    await page.route('**/api/engines', route => route.fulfill({ json: { engines: [
      { id: 'classical', name: 'Classical search', available: true },
      { id: 'transformer', name: 'Transformer', available: true, status: 'ready' },
    ] } }));
    await page.route('**/api/analyze', async route => {
      assert.equal(route.request().postDataJSON().engine, 'transformer');
      currentJob = { id: `rankings-${nextJob++}`, version: 0, status: 'running', delayMs: 12,
        pollStarts: [], inFlight: 0, maxInFlight: 0, stopped: false, holdNext: null };
      jobs.set(currentJob.id, currentJob);
      await route.fulfill({ status: 202, json: { jobId: currentJob.id } });
    });
    await page.route('**/api/analysis/**', async route => {
      const pieces = new URL(route.request().url()).pathname.split('/');
      const job = jobs.get(pieces[3]);
      if (!job) return route.continue();
      if (pieces[4] === 'stop') {
        job.stopped = true;
        await route.fulfill({ json: { status: 'cancelled' } });
        return;
      }
      job.pollStarts.push(performance.now());
      job.inFlight++;
      job.maxInFlight = Math.max(job.maxInFlight, job.inFlight);
      try {
        const hold = job.holdNext;
        job.holdNext = null;
        if (hold) { hold.started.resolve(); await hold.release.promise; }
        else await delay(job.delayMs);
        const data = snapshot(job.version, job.status === 'done');
        if (job.stale) { data.notation = 'Stale transformer result'; data.rankings[0].entries[0].notation = 'Stale ranking'; }
        await route.fulfill({ json: { jobId: job.id, status: job.status,
          ...(job.status === 'done' ? { result: data } : { progress: data }) } });
      } finally { job.inFlight--; }
    });
    await page.route('**/api/play', async route => {
      const request = route.request().postDataJSON(), job = jobs.get(request.jobId);
      assert(job && job.status === 'done', 'Play best must use the completed displayed job.');
      const result = snapshot(job.version, true);
      played.push({ request, notation: result.notation });
      let revision = request.revision, game;
      for (const move of result.bestAction) {
        const response = await page.request.post(`${origin}/api/move`, { data: { revision, move } });
        assert.equal(response.status(), 200);
        game = await response.json();
        revision = game.revision;
      }
      const response = await page.request.post(`${origin}/api/submit`, { data: { revision } });
      assert.equal(response.status(), 200);
      await route.fulfill({ json: await response.json() });
    });

    await page.goto(origin);
    await page.locator('#connection.online').waitFor();
    await page.locator('#engine-select').selectOption('transformer');
    await page.locator('#analyze-button').click();
    await page.locator('#best-move').filter({ hasText: firstNotation }).waitFor();
    assert.equal(await page.locator('#search-status').textContent(), 'SEARCHING');
    assert.equal(await page.locator('#play-button').isDisabled(), true, 'Live recommendations cannot play an unfinished job.');
    await page.locator('#continuation-rankings').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#ranking-list > li').count(), 10);
    assert.match(await page.locator('#ranking-summary').textContent(), /10.*20.*White/i);
    assert.deepEqual(await page.locator('#ranking-list > li .evaluation-badge').allTextContents(), ['True', ...Array(9).fill('Candidate')]);
    const job = currentJob;
    await until(() => job.pollStarts.length >= 7, 'seven fast analysis polls');
    const fastIntervals = job.pollStarts.slice(1, 7).map((time, index) => time - job.pollStarts[index]);
    const fastMedian = median(fastIntervals);
    assert(fastMedian >= 70 && fastMedian < 180, `Fast polling should target 100ms, observed median ${fastMedian.toFixed(1)}ms.`);

    job.version = 1;
    await page.locator('#best-move').filter({ hasText: secondNotation }).waitFor();
    assert.equal(await page.locator('#search-status').textContent(), 'SEARCHING', 'The leader changes before search completion.');
    assert.equal(await page.locator('#best-evaluation').textContent(), 'True');
    assert.match(await page.locator('#best-evaluation-score').textContent(), /\+2\.35/);
    assert.equal(await page.locator('#ranking-list > li').first().getAttribute('data-entry-id'), '2');
    assert.equal(await page.locator('#ranking-list > li').nth(1).locator('.evaluation-badge').textContent(), 'True');

    const depthTwo = page.locator('#ranking-tabs [role="tab"][data-depth="2"]');
    await depthTwo.click();
    const depthTwoNode = await depthTwo.elementHandle();
    const details = page.locator('#ranking-list > li').first().locator('details');
    await details.locator('summary').click();
    const detailsNode = await details.elementHandle();
    assert.match(await page.locator('#ranking-summary').textContent(), /10.*24.*Black/i);
    assert.match(await details.textContent(), /d4/);
    job.version = 2;
    await page.locator('#ranking-tabs [role="tab"][data-depth="4"]').waitFor();
    assert.equal(await depthTwo.getAttribute('aria-selected'), 'true', 'Selected depth survives progress updates and new depths.');
    assert(await depthTwoNode.evaluate(node => node.isConnected), 'Tab elements remain stable across updates.');
    assert(await detailsNode.evaluate(node => node.isConnected && node.open), 'Open contextual lines survive updates.');
    assert.equal(await page.locator('#ranking-list > li').nth(1).locator('.evaluation-badge').textContent(), 'True', 'Candidate promotion appears in the selected depth.');

    await depthTwo.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#ranking-tabs [aria-selected="true"]').getAttribute('data-depth'), '3');
    await page.keyboard.press('End');
    assert.equal(await page.locator('#ranking-tabs [aria-selected="true"]').getAttribute('data-depth'), '4');
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#ranking-tabs [aria-selected="true"]').getAttribute('data-depth'), '1');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#ranking-tabs [aria-selected="true"]').getAttribute('data-depth'), '4');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#ranking-tabs [aria-selected="true"]').getAttribute('data-depth'), '1');
    assert.equal(await page.locator('#ranking-tabs [role="tab"][tabindex="0"]').count(), 1);

    job.delayMs = 240;
    const slowStart = job.pollStarts.length;
    await until(() => job.pollStarts.length >= slowStart + 5, 'delayed sequential polls');
    const slowTimes = job.pollStarts.slice(-4), slowIntervals = slowTimes.slice(1).map((time, index) => time - slowTimes[index]);
    const slowMedian = median(slowIntervals);
    assert(slowMedian >= 225 && slowMedian < 320, `Slow responses should not add another 100ms delay, observed median ${slowMedian.toFixed(1)}ms.`);
    assert.equal(job.maxInFlight, 1, 'Only one analysis poll is in flight, including slow responses.');
    job.delayMs = 12;

    // A provisional candidate may lead the live rankings even though the
    // playable True recommendation remains d4. Completion must switch back to
    // the exact result used by Play best instead of retaining that candidate.
    job.version = 3;
    await page.locator('#best-move').filter({ hasText: firstNotation }).waitFor();
    assert.equal(await page.locator('#best-evaluation').textContent(), 'Candidate');
    assert.match(await page.locator('#best-evaluation-score').textContent(), /\+3\.10/);
    assert.equal(await page.locator('#play-button').isDisabled(), true);

    await depthTwo.click();
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/rankings-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Rankings fit a 390px viewport.');
    const bounds = await page.locator('#continuation-rankings').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'Rankings panel stays inside the mobile viewport.');
    await page.screenshot({ path: 'artifacts/rankings-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });

    job.status = 'done';
    await page.waitForFunction(() => !document.getElementById('play-button').disabled);
    const displayedFinal = await page.locator('#best-move').textContent();
    assert.equal(displayedFinal, secondNotation);
    await page.locator('#play-button').click();
    await page.locator('#history-count').filter({ hasText: '1 turn' }).waitFor();
    assert.equal(played.at(-1).request.jobId, job.id);
    assert.equal(played.at(-1).notation, displayedFinal, 'Play best applies the displayed final leader.');
    assert.match(await page.locator('#move-history').textContent(), /d4/);
    assert.equal(await page.locator('#turn-label').textContent(), 'Black to play');
    await page.locator('#new-button').click();
    await page.locator('#history-count').filter({ hasText: '0 turns' }).waitFor();

    async function heldSearch() {
      await page.locator('#analyze-button').click();
      await page.locator('#best-move').filter({ hasText: firstNotation }).waitFor();
      assert.equal(await page.locator('#ranking-tabs [aria-selected="true"]').getAttribute('data-depth'), '1', 'A new search starts at depth one.');
      const pendingJob = currentJob;
      const hold = { started: deferred(), release: deferred() };
      gates.push(hold);
      pendingJob.holdNext = hold;
      await hold.started.promise;
      pendingJob.stale = true;
      return { pendingJob, hold };
    }
    async function assertCleared(pendingJob, hold) {
      await until(() => pendingJob.stopped, 'stale search cancellation');
      hold.release.resolve();
      await until(() => pendingJob.inFlight === 0, 'stale response completion');
      await page.waitForTimeout(150);
      assert.equal(await page.locator('#best-move').isVisible(), false, 'Stale progress cannot restore the leader.');
      assert.equal(await page.locator('#continuation-rankings').isVisible(), false, 'Stale progress cannot restore rankings.');
      assert.equal(await page.locator('#play-button').isDisabled(), true);
      assert.equal(await page.locator('#eval-score').textContent(), '—');
    }
    const engineStale = await heldSearch();
    await page.locator('#engine-select').selectOption('classical');
    await assertCleared(engineStale.pendingJob, engineStale.hold);
    await page.locator('#engine-select').selectOption('transformer');
    const positionStale = await heldSearch();
    await page.locator('#new-button').click();
    await assertCleared(positionStale.pendingJob, positionStale.hold);
    assert.deepEqual(errors, []);
    console.log(`Rankings browser smoke passed: live leaders, 10 rows/depth, True/Candidate promotion, stable keyboard tabs and expanded lines, ${fastMedian.toFixed(1)}ms fast / ${slowMedian.toFixed(1)}ms delayed polls, one poll in flight, final Play best, stale engine/position clearing, mobile width.`);
    console.log('Screenshots: artifacts/rankings-desktop.png, artifacts/rankings-mobile.png. Transformer inference is mocked.');
  } finally {
    for (const gate of gates) gate.release.resolve();
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
