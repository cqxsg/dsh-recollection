import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

async function until(predicate, label) {
  const end = performance.now() + 15_000;
  while (performance.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

/** Real Web selection, using only the test probe to identify its report page. */
export async function openDiagnosticBrowser(ctx, base, ids) {
  let executablePath;
  for (const path of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
    try { await access(path); executablePath = path; break; } catch {}
  }
  if (!executablePath) throw new Error('Diagnostic browser validation requires Chrome or Edge.');
  const browser = await chromium.launch({ executablePath, headless: true });
  const errors = [];
  let page;
  try {
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(ctx.connection.authenticatedUrl(base));
    await page.waitForFunction(() => Boolean(window.__recallProbe?.recallClient), undefined, { timeout: 25_000 });
    const pageId = await page.evaluate(() => window.__recallProbe.recallClient.pageId);
    const state = () => ctx.recallPages.snapshot().find(row => row.pageId === pageId);
    const welcome = page.getByText('开始使用', { exact: true });
    // The optional credentials dialog appears asynchronously after Continue.
    // Handle it during actionability checks instead of a one-time visibility race.
    await page.addLocatorHandler(welcome, async () => { await page.keyboard.press('Escape'); await welcome.waitFor({ state: 'hidden' }); });
    await page.getByRole('button', { name: '继续', exact: true }).click();
    // Some installed adapters need no onboarding credentials and Continue closes the wizard directly.
    await page.getByRole('button', { name: '继续', exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('未分组', { exact: true }).click();
    const select = async id => {
      await page.getByText(id === ids.a ? 'Diagnostic fixture A' : 'Diagnostic fixture B', { exact: true }).first().click();
      await until(() => state()?.view?.sessionId === id, `real Web selection ${id}`);
      assert.equal(state().view.selection, 'selected');
    };
    await select(ids.a);
    return {
      select, state,
      async finish() {
        assert.deepEqual(errors, []);
        const screenshot = join(process.env.DSH_HOME, '..', 'diagnostic-page-b.png');
        await page.screenshot({ path: screenshot, fullPage: true });
        return { browser: browser.version(), pageId, selectedSessionId: state().view.sessionId, screenshot, pageErrors: errors };
      },
      close: () => browser.close(),
    };
  } catch (error) {
    if (page) { await page.screenshot({ path: join(process.env.DSH_HOME, '..', 'diagnostic-browser-failure.png'), fullPage: true }); await writeFile(join(process.env.DSH_HOME, '..', 'diagnostic-browser-failure.txt'), await page.locator('body').innerText()); }
    await browser.close(); throw error;
  }
}
