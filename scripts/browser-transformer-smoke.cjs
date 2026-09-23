// Optional real-model UI integration check. Requires a trained checkpoint and
// Playwright (or PLAYWRIGHT_MODULE/CHROME_PATH). Uses an isolated local game.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

(async () => {
  const { createApp } = await import('../src/server.js');
  const server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport:{width:1440, height:1100}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#connection.online').waitFor();
    const catalog = await page.request.get(new URL('/api/engines', page.url()).href).then(response => response.json());
    assert.equal(catalog.engines.find(engine => engine.id === 'transformer').available, true, 'Set up and train a local transformer first.');
    await page.locator('#engine-select').selectOption('transformer');
    await page.locator('#time-budget').selectOption('3000');
    await page.locator('#search-depth').selectOption('2');
    const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/analyze');
    await page.locator('#analyze-button').click();
    const creation = await created;
    assert.equal(creation.status(), 202);
    const {jobId} = await creation.json();
    await page.waitForFunction(() => !document.getElementById('play-button').disabled, null, {timeout:20000});
    const job = await page.request.get(new URL(`/api/analysis/${jobId}`, page.url()).href).then(response => response.json());
    assert.equal(job.result.engine, 'transformer');
    assert.ok(job.result.model.trainedSteps > 0);
    assert.ok(Number.isFinite(job.result.score));
    assert.equal(await page.locator('#stat-cache').textContent(), `Model: ${job.result.model.device}`);
    assert.equal(await page.locator('#cache-memory').isDisabled(), true);
    assert.match(await page.locator('#analysis-note').textContent(), /Selective transformer search/);
    await page.locator('#refresh-engines').click();
    await page.locator('#engine-readiness').filter({hasText:'Transformer ready'}).waitFor();
    await fs.mkdir('artifacts', {recursive:true});
    await page.screenshot({path:'artifacts/transformer-real-desktop.png', fullPage:true});
    await page.setViewportSize({width:390, height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path:'artifacts/transformer-real-mobile.png', fullPage:true});
    await page.locator('#play-button').click();
    await page.locator('#history-count').filter({hasText:'1 turn'}).waitFor();
    assert.equal(await page.locator('#turn-label').textContent(), 'Black to play');
    await page.locator('#engine-select').selectOption('classical');
    assert.equal(await page.locator('#cache-memory').isDisabled(), false);
    assert.deepEqual(errors, []);
    console.log(`Real transformer browser smoke passed: ${job.result.model.device}, ${job.result.model.trainedSteps} training steps, depth ${job.result.depth}, legal Play best, engine switch, mobile layout.`);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
