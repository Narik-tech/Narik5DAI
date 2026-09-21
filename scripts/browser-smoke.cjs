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
    await page.getByRole('button', { name: '(0L T1) e2, white pawn', exact: true }).click();
    await page.getByRole('button', { name: '(0L T1) e4, empty, available destination', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('submit-button').disabled);
    await page.locator('#ai-side').selectOption('black');
    await page.locator('#submit-button').click();
    await page.locator('#history-count').filter({ hasText: '2 turns' }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#turn-label').textContent(), 'White to play');
    await page.locator('#ai-side').selectOption('off');
    await page.locator('#new-button').click();
    await page.locator('#history-count').filter({ hasText: '0 turns' }).waitFor();
    await page.locator('#analyze-button').click();
    await page.waitForFunction(() => !document.getElementById('play-button').disabled, null, { timeout: 15000 });
    assert.notEqual(await page.locator('#eval-score').textContent(), '—');
    await page.locator('#play-button').click();
    await page.locator('#turn-label').filter({ hasText: 'Black to play' }).waitFor();
    await page.locator('#undo-button').click();
    await page.locator('#turn-label').filter({ hasText: 'White to play' }).waitFor();
    await page.locator('#notation-button').click();
    assert.match(await page.locator('#pgn-input').inputValue(), /Board/);
    await page.locator('#pgn-input').fill(await fs.readFile('examples/time-travel.5dpgn', 'utf8'));
    await page.locator('#import-pgn').click();
    await page.locator('#notation-dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '(0L T5) b3, white queen', exact: true }).click();
    const past = page.locator('.board-card[aria-label="Timeline 0, T1, White board"]');
    await past.getByRole('button', { name: '(0L T1) f7, black pawn, available destination', exact: true }).click();
    await page.locator('#timeline-count').filter({ hasText: '2 TIMELINES' }).waitFor();
    assert.match(await page.locator('#pending-moves').textContent(), /f7/);
    await page.waitForFunction(() => !document.getElementById('submit-button').disabled);
    await page.screenshot({ path: 'artifacts/time-travel.png', fullPage: true });
    await page.locator('#submit-button').click();
    await page.locator('#turn-label').filter({ hasText: 'Black to play' }).waitFor();
    await page.locator('#variant').selectOption('two_timelines');
    await page.locator('#new-button').click();
    await page.locator('#timeline-count').filter({ hasText: '2 TIMELINES' }).waitFor();
    await page.locator('#turn-label').filter({ hasText: 'White to play' }).waitFor();
    assert.match(await page.locator('.timeline-label').first().textContent(), /\+0/);
    await page.screenshot({ path: 'artifacts/timelines.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page must fit mobile width.');
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (let board = 0; board < 2; board++) {
      await page.locator('.board-card.playable').first().getByRole('button', { name: / e2, white pawn$/ }).click();
      await page.locator('.board-card.selected-board').getByRole('button', { name: / e4, empty, available destination$/ }).click();
      await page.locator('#pending-summary').filter({ hasText: `${board + 1} move` }).waitFor();
      assert.equal(await page.locator('#submit-button').isDisabled(), board === 0);
    }
    await page.locator('#submit-button').click();
    await page.locator('#turn-label').filter({ hasText: 'Black to play' }).waitFor();
    await page.locator('#time-budget').selectOption('60000');
    await page.locator('#search-depth').selectOption('12');
    await page.locator('#analyze-button').click();
    await page.locator('#analyze-label').filter({ hasText: 'Stop analysis' }).waitFor();
    await page.locator('#analyze-button').click();
    await page.locator('#search-status').filter({ hasText: 'STOPPED' }).waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: manual moves, AI reply, analysis/play, undo, PGN import/export, temporal capture, multi-board submission, cancellation, mobile width.');
    await page.locator('#variant').selectOption('standard');
    await page.locator('#new-button').click();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
