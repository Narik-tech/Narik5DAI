// Optional browser integration check. Install Playwright separately or provide
// PLAYWRIGHT_MODULE and CHROME_PATH for an existing development runtime.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.APP_URL || 'http://127.0.0.1:5173');
    await page.locator('#connection.online').waitFor();
    await page.locator('#new-button').click();
    await page.locator('#turn-label').filter({ hasText: 'White to play' }).waitFor();
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
    await page.locator('#time-budget').selectOption('1000');
    await page.locator('#search-depth').selectOption('2');
    await page.locator('#analyze-button').click();
    await page.waitForFunction(() => !document.getElementById('play-button').disabled, { timeout: 15000 });
    assert.notEqual(await page.locator('#eval-score').textContent(), '—');
    await page.locator('#play-button').click();
    await page.locator('#turn-label').filter({ hasText: 'Black to play' }).waitFor();
    await page.locator('#undo-button').click();
    await page.locator('#turn-label').filter({ hasText: 'White to play' }).waitFor();
    await page.locator('#notation-button').click();
    assert.match(await page.locator('#pgn-input').inputValue(), /Board/);
    await page.locator('#notation-dialog [aria-label="Close"]').click();
    await page.locator('#variant').selectOption('two_timelines');
    await page.locator('#new-button').click();
    await page.locator('#timeline-count').filter({ hasText: '2 TIMELINES' }).waitFor();
    await page.screenshot({ path: 'artifacts/timelines.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page must fit mobile width.');
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: analyze, play, undo, export, two timelines, mobile width.');
    await page.locator('#variant').selectOption('standard');
    await page.locator('#new-button').click();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
