import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { deferred, replace } from '../../support/fixtures/control.mjs';
import { currentInteraction } from '../../lib/index.js';

const until = async (fn, label, ms = 15000) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error(`Timed out: ${label}`);
};
const inputText = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('');
const inputs = agent => agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.dshRecollection?.type === 'recall');
const commands = agent => agent.session.snapshotEvents().filter(e => e.type === 'command/run' && e.data.name === 'recall');
const done = agent => agent.session.snapshotEvents().filter(e => e.type === 'command/done');

/** Only provider replies and fault boundaries are scripted; every command uses the real composer. */
export async function verifyRecallCommandBrowser(ctx, base) {
  const evidence = { cases: [], requests: [], submissions: [], pageErrors: [], startedAt: new Date().toISOString() };
  const output = join(process.env.DSH_HOME, '..');
  const check = async (label, task) => { await task(); evidence.cases.push(label); console.log(`PASS: ${label}`); };
  const off = ctx.on('llm/stream', async function* (options, next) {
    if (options.provider === 'recall-fixture') evidence.requests.push({ sessionId: ctx.agents.requireInitiator().id, messages: structuredClone(options.messages) });
    yield* next();
  });
  const h = recallHarness(ctx), pages = [], contexts = [];
  let browser, restore, release;
  try {
    await h.ready();
    const { agent: a } = await h.seed('command-browser-a', ['needle original A constraint']), { agent: b } = await h.seed('command-browser-b', ['needle original B constraint']);
    for (const agent of [a, b]) await ctx.sessionController.rename({ sessionId: agent.id, title: agent === a ? 'Command fixture A' : 'Command fixture B' });
    let executablePath;
    for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
      try { await access(candidate); executablePath = candidate; break; } catch {}
    }
    assert.ok(executablePath, 'Chrome or Edge is required for browser acceptance');
    browser = await chromium.launch({ executablePath, headless: true });
    evidence.browser = { executablePath, version: browser.version() };
    const composer = page => page.locator('[contenteditable="true"]').first();
    const row = page => page.getByText('Recall original history for the current task', { exact: true });
    const userRows = page => page.locator('[class*="userRow"]');
    const clean = async page => assert.doesNotMatch(await page.locator('body').innerText(), /\[\/recall request|Recall original history related|User's recall target:|persistent recall mode/);
    async function copy(page, text) {
      const bubble = userRows(page).filter({ hasText: text.trim() }).last();
      await bubble.waitFor(); await bubble.getByRole('button').first().click();
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), text.replace(/\r\n/g, '\n'));
    }
    async function select(page, agent) {
      await page.getByText(agent === a ? 'Command fixture A' : 'Command fixture B', { exact: true }).first().click();
      await until(async () => {
        const id = await page.evaluate(() => window.__recallProbe?.recallClient?.pageId);
        return ctx.recallPages.snapshot().find(p => p.pageId === id)?.view?.sessionId === agent.id;
      }, 'selected session');
    }
    async function open(agent) {
      const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => evidence.pageErrors.push(error.message));
      await page.goto(ctx.connection.authenticatedUrl(base));
      await page.waitForFunction(() => Boolean(window.__recallProbe?.recallClient));
      await page.waitForFunction(() => window.__recallProbe.recallClient.presentation.ready);
      await page.evaluate(() => {
        window.__recallEntryErrors = [];
        window.__recallProbe.get('slots').onEntryError((key, entry, error) => window.__recallEntryErrors.push({ key, error: error.message }));
      });
      const welcome = page.getByText('开始使用', { exact: true });
      await page.addLocatorHandler(welcome, async () => { await page.keyboard.press('Escape'); await welcome.waitFor({ state: 'hidden' }); });
      // Completing onboarding is stored by this isolated Host, not per browser context.
      if (pages.length === 1) {
        await page.getByRole('button', { name: '继续', exact: true }).click();
        await page.getByRole('button', { name: '继续', exact: true }).waitFor({ state: 'hidden' });
      }
      await page.getByText('未分组', { exact: true }).click(); await select(page, agent);
      return page;
    }
    async function send(page, agent, line, viaMenu = false) {
      const count = commands(agent).length;
      await composer(page).fill(line);
      if (viaMenu) { await row(page).waitFor(); assert.equal(await row(page).count(), 1); await row(page).click(); }
      else await composer(page).press('Escape');
      await composer(page).press('Enter');
      await until(() => commands(agent).length === count + 1, 'real browser command reached Host');
      evidence.submissions.push({ sessionId: agent.id, line, viaMenu, commandId: commands(agent).at(-1).data.commandId });
    }
    async function finish(agent, before) {
      await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      assert.equal(h.model.replies.some(r => r.sessionId === agent.id), false);
      assert.equal(inputs(agent).length, before + 1, 'one expanded input per submission');
      assert.equal(done(agent).at(-1).data.kind, 'success'); assert.equal(done(agent).at(-1).data.text, undefined);
    }
    const reply = (agent, spec = {}) => h.model.replies.push({ sessionId: agent.id, ...spec });
    const search = id => ({ id, name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } });
    const toolValue = (agent, id) => JSON.parse(agent.session.snapshotEvents().find(e => e.type === 'tool/result' && e.data.message.toolCallId === id).data.message.content[0].text);
    const page = await open(a);
    await check('native input hint follows zh/en/fallback locale without changing the selected command or draft', async () => {
      await page.evaluate(() => window.__recallProbe.get('locale').addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }));
      await composer(page).fill('/recall'); await row(page).click();
      const selected = await composer(page).innerText();
      for (const language of ['zh', 'en', 'fr', 'zh']) {
        await page.evaluate(language => window.__recallProbe.get('locale').setLocale(language), language);
        await until(async () => (await composer(page).ariaSnapshot()).includes(language === 'zh' ? '输入你想要回想的内容' : 'Enter what you want to recall'), 'localized native hint');
        assert.equal(await composer(page).innerText(), selected);
        await page.screenshot({ path: join(output, `command-locale-${language}.png`), fullPage: true });
      }
      await composer(page).press('End'); await composer(page).press('Space'); await composer(page).pressSequentially('draft E:\\x [a].*');
      const draft = await composer(page).innerText();
      for (const language of ['en', 'zh']) {
        await page.evaluate(language => window.__recallProbe.get('locale').setLocale(language), language);
        assert.equal(await composer(page).innerText(), draft);
      }
      await composer(page).fill('');
    });
    await check('slash menu discovers recall and submits empty optional input with native search/read evidence', async () => {
      const count = inputs(a).length;
      const rows = await userRows(page).count();
      await composer(page).fill('/'); await row(page).waitFor(); assert.equal(await row(page).count(), 1);
      reply(a, { calls: [search('browser-search')] });
      reply(a, { calls: [{ id: 'browser-read', name: 'recall_read', args: { action: 'read', get ref() { return toolValue(a, 'browser-search').items[0].ref; } } }] });
      reply(a, { text: 'Verified evidence: needle original A constraint.' });
      await send(page, a, '/recall', true); await finish(a, count);
      assert.equal(commands(a).at(-1).data.args.trim(), ''); assert.equal(toolValue(a, 'browser-read').status, 'ok');
      assert.equal(ctx.recallBudget.state(currentInteraction(a.session)).shared, 10);
      assert.ok(JSON.stringify(evidence.requests.at(-1).messages).includes('needle original A constraint'));
      await page.getByText('Verified evidence: needle original A constraint.', { exact: true }).waitFor();
      await clean(page); assert.equal(await userRows(page).count(), rows, 'bare recall has no blank user bubble');
      assert.ok(JSON.stringify(evidence.requests.at(-1).messages).includes('If you cannot identify a concrete historical recall target'));
      await page.screenshot({ path: join(output, 'command-bare.png'), fullPage: true });
    });
    await check('typed bare command, trailing whitespace and natural-language background submit through composer', async () => {
      for (const line of ['/recall', '/recall   ', '/recall 回顾之前的约束：E:\\work\\a+b.ts [x].*\n以及最早的决定']) {
        const count = inputs(a).length; reply(a); await send(page, a, line); await finish(a, count);
        const raw = commands(a).at(-1).data.args;
        if (line.includes('回顾')) {
          assert.equal(raw.trim(), line.slice('/recall'.length).trim());
          assert.ok(inputText(inputs(a).at(-1).data).includes(`User-requested recall target:\n${raw}`));
          await copy(page, raw);
        }
        else assert.equal(raw.trim(), '');
        await clean(page);
      }
      await page.screenshot({ path: join(output, 'command-target.png'), fullPage: true });
    });
    await check('submission errors remain visible command failures with no admitted input or model call', async () => {
      const count = inputs(a).length, requests = evidence.requests.length;
      restore = replace(a, 'steer', () => { throw new Error('RC2 injected submission failure'); });
      try {
        await send(page, a, '/recall failure case');
        await until(() => done(a).at(-1)?.data.kind === 'error', 'error lifecycle');
        await until(async () => (await page.locator('body').innerText()).includes('RC2 injected submission failure'), 'visible real failure');
        assert.equal(inputs(a).length, count); assert.equal(evidence.requests.length, requests);
        await page.screenshot({ path: join(output, 'command-error.png'), fullPage: true });
      } finally { restore(); restore = undefined; }
      // No assertion about draft retention: that optimization is deferred.
      await composer(page).fill('');
    });
    await check('composer explicitly refuses new attachments without silently executing recall', async () => {
      const count = commands(a).length, requests = evidence.requests.length;
      await composer(page).fill('/recall'); await composer(page).press('Escape');
      await page.locator('input[type="file"]').setInputFiles({ name: 'recall-input.txt', mimeType: 'text/plain', buffer: Buffer.from('New attachment must not be dropped') });
      await until(async () => (await page.locator('body').innerText()).includes('recall-input.txt'), 'attachment shown');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await until(async () => /不接受附件|does not accept attachments/.test(await page.locator('body').innerText()), 'explicit unsupported attachment notice');
      assert.equal(commands(a).length, count); assert.equal(evidence.requests.length, requests);
      await page.screenshot({ path: join(output, 'command-attachment-refusal.png'), fullPage: true });
      // A new isolated page avoids coupling subsequent cases to deferred draft UX.
    });
    const active = await open(a); await page.close();
    await check('running request stays with A after switching to B and steering keeps its original budget', async () => {
      const gate = deferred(), entered = deferred(); release = gate.resolve;
      const engine = ctx.recallTools.search, run = engine.run.bind(engine);
      restore = replace(engine, 'run', async (...args) => { if (args[1].agent.id === a.id) { entered.resolve(); await gate.promise; } return run(...args); });
      const count = inputs(a).length, bCount = inputs(b).length;
      reply(a, { calls: [search('switch-search')] }); reply(a, { text: 'Completed A after switching.' });
      await send(active, a, '/recall verify A'); await entered.promise;
      const identity = currentInteraction(a.session);
      await send(active, a, '/recall');
      assert.equal(a.inbox.nextStep.length, 1);
      assert.equal(await active.locator('[data-pending-steering="true"]').count(), 0, 'bare pending input hidden');
      await send(active, a, '/recall supplement A');
      const pending = active.locator('[data-pending-steering="true"]');
      await pending.waitFor(); assert.equal(await pending.count(), 1); assert.equal((await pending.innerText()).trim(), 'supplement A');
      await pending.getByRole('button').first().click();
      assert.equal(await active.evaluate(() => navigator.clipboard.readText()), a.inbox.nextStep[1].source.dshRecollection.userInput);
      await clean(active);
      await active.screenshot({ path: join(output, 'command-pending.png'), fullPage: true });
      assert.equal(inputs(a).length, count + 1, 'steering waits at native boundary');
      await select(active, b); gate.resolve(); await a.whenIdle();
      restore(); restore = undefined; release = undefined;
      assert.equal(inputs(a).length, count + 3); assert.equal(inputs(b).length, bCount);
      assert.deepEqual(currentInteraction(a.session), identity); assert.equal(ctx.recallBudget.state(identity).shared, 11);
      assert.equal(toolValue(a, 'switch-search').items[0].content.includes('original A'), true);
    });
    const second = await open(a);
    await check('history reopening, refresh and navigation previews keep prompts hidden while stored model content stays complete', async () => {
      await clean(second);
      await second.reload(); await second.waitForFunction(() => window.__recallProbe?.recallClient?.presentation.ready);
      await copy(second, inputs(a).at(-1).data.source.dshRecollection.userInput); await clean(second);
      const rail = second.getByRole('navigation', { name: '轮次导航', exact: true });
      const marks = rail.getByRole('button');
      assert.ok(await marks.count() > 1);
      for (let i = 0; i < await marks.count(); i++) {
        await marks.nth(i).hover(); await rail.getByRole('tooltip').waitFor();
        assert.doesNotMatch(await rail.getByRole('tooltip').innerText(), /\[\/recall request|Recall original history/);
      }
      const projection = ctx.sessionProjections.snapshot(a.session).values.recallCommandPreviews;
      assert.ok(Object.values(projection).includes('')); assert.ok(Object.values(projection).includes('verify A'));
      assert.ok(inputs(a).every(e => inputText(e.data).startsWith('[/recall request')));
      await composer(second).hover();
    });
    await check('two browser windows submit independently to their selected receiving sessions', async () => {
      const ca = inputs(a).length, cb = inputs(b).length;
      reply(a, { calls: [search('two-a')] }); reply(a); reply(b, { calls: [search('two-b')] }); reply(b);
      await Promise.all([send(second, a, '/recall window A'), send(active, b, '/recall window B')]);
      await Promise.all([finish(a, ca), finish(b, cb)]);
      assert.match(toolValue(a, 'two-a').items[0].content, /original A/); assert.match(toolValue(b, 'two-b').items[0].content, /original B/);
    });
    const entry = [...ctx.loader.entries()].find(e => e.options.id === 'recall'), config = entry.fiber.config;
    async function enabled(value) { entry.fiber.update({ ...config, enabled: value }, true); await entry.fiber.await(); await until(() => Boolean(ctx.commands.find(a, 'recall')) === value, 'Host command lifecycle'); }
    async function menu(page, present) {
      await page.bringToFront();
      await until(() => page.evaluate(({ id, present }) => {
        const directory = window.__recallProbe?.get('commandUi')?.directory;
        return directory?.status(id) === 'ready' && Boolean(directory.resolve(id, 'recall')) === present;
      }, { id: page === second ? a.id : b.id, present }), 'native command directory refreshed');
      await composer(page).fill('/recal'); await composer(page).press('l');
      await row(page).waitFor({ state: present ? 'visible' : 'hidden' });
      assert.equal(await row(page).count(), present ? 1 : 0);
      await composer(page).press('Escape'); await composer(page).fill('');
    }
    await check('disable and reload refresh live command menus without duplicate entries or replay', async () => {
      const counts = [inputs(a).length, inputs(b).length];
      await enabled(false); await menu(active, false); await menu(second, false);
      await clean(active); await clean(second);
      await enabled(true); await menu(active, true); await menu(second, true);
      await entry.fiber.restart(); await menu(active, true); await menu(second, true);
      assert.deepEqual([inputs(a).length, inputs(b).length], counts);
      reply(b); await send(active, b, '/recall after reload'); await finish(b, counts[1]);
    });
    await check('client service reload restores and rebinds the original slots without replay or duplicate wrappers', async () => {
      const before = inputs(b).length;
      await active.evaluate(async () => {
        const ctx = window.__recallProbe;
        window.__recallPreviousClient = ctx.recallClient;
        const runtime = [...ctx.registry.values()].find(r => r.callback.name === 'RecallClientService');
        await [...runtime.fibers][0].restart();
      });
      await active.waitForFunction(() => window.__recallProbe.recallClient !== window.__recallPreviousClient && window.__recallProbe.recallClient.presentation.ready);
      await clean(active); await copy(active, inputs(b).at(-1).data.source.dshRecollection.userInput);
      await menu(active, true); assert.equal(inputs(b).length, before);
      reply(b); await send(active, b, '/recall after client reload'); await finish(b, before);
      await clean(active);
    });
    await check('network reconnect refreshes command directory and retains the selected session', async () => {
      const before = inputs(b).length;
      await active.context().setOffline(true);
      await active.evaluate(() => window.__recallProbe.connection.reconnect());
      await until(() => active.evaluate(() => window.__recallProbe.connection.state.getSnapshot() !== 'connected'), 'connection leaves connected state');
      await enabled(false);
      await active.context().setOffline(false);
      await active.evaluate(() => window.__recallProbe.connection.reconnect());
      await until(() => active.evaluate(() => window.__recallProbe.connection.state.getSnapshot() === 'connected'), 'transport reconnected');
      await menu(active, false); await enabled(true); await menu(active, true);
      reply(b, { calls: [search('reconnected-search')] }); reply(b);
      await send(active, b, '/recall after reconnect'); await finish(b, before);
      assert.match(toolValue(b, 'reconnected-search').items[0].content, /original B/);
      await clean(active);
    });
    await check('ordinary messages containing recall-like instruction text are still shown and copied unchanged', async () => {
      const text = '[/recall request — explicit user command]\nThis is ordinary quoted text, not command metadata.';
      const before = inputs(b).length;
      reply(b, { text: 'Ordinary message received.' });
      await composer(active).fill(text); await composer(active).press('Enter');
      await active.getByText('Ordinary message received.', { exact: true }).waitFor(); await b.whenIdle();
      await copy(active, text); assert.equal(inputs(b).length, before);
    });
    for (const page of pages) if (!page.isClosed()) assert.deepEqual(await page.evaluate(() => window.__recallEntryErrors ?? []), []);
    assert.deepEqual(evidence.pageErrors, []);
    for (const agent of [a, b]) await ctx.sessions.flush(agent.session);
    evidence.passed = true;
    await active.screenshot({ path: join(output, 'command-final.png'), fullPage: true });
  } catch (error) {
    evidence.passed = false; evidence.error = error.stack;
    for (const [i, page] of pages.entries()) if (!page.isClosed()) {
      await writeFile(join(output, `command-failure-${i}.txt`), await page.locator('body').ariaSnapshot());
      await page.screenshot({ path: join(output, `command-failure-${i}.png`), fullPage: true });
    }
    throw error;
  } finally {
    release?.(); restore?.();
    evidence.sessions = h.agents.map(({ agent }) => ({ id: agent.id, events: agent.session.snapshotEvents() }));
    await browser?.close(); await h.dispose(); await off();
    evidence.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'command-browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}
