import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { deferred, replace } from '../../support/fixtures/control.mjs';

const until = async (fn, label) => {
  const end = performance.now() + 15000;
  while (performance.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error(`Timed out: ${label}`);
};

/** Investigation of the unmodified baseline's public extension boundary, not a product adapter. */
export async function verifyRecallPresentationProbe({ ctx, agent, h, evidence, check, output }) {
  let browser, page, release, restore;
  try {
    let executablePath;
    for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
      try { await access(candidate); executablePath = candidate; break; } catch {}
    }
    assert.ok(executablePath);
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage(); evidence.pageErrors = [];
    page.on('pageerror', error => evidence.pageErrors.push(error.message));
    evidence.browser = { executablePath, version: browser.version() };
    await ctx.sessionController.rename({ sessionId: agent.id, title: 'RC4a presentation probe' });
    await page.goto(ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`));
    await page.waitForFunction(() => Boolean(window.__recallProbe?.recallClient));
    const welcome = page.getByText('开始使用', { exact: true });
    await page.addLocatorHandler(welcome, async () => { await page.keyboard.press('Escape'); await welcome.waitFor({ state: 'hidden' }); });
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('未分组', { exact: true }).click();
    await page.getByText('RC4a presentation probe', { exact: true }).first().click();
    const composer = () => page.locator('[contenteditable="true"]').first();
    const nodes = () => page.evaluate(id => {
      try { return window.__recallProbe.get('uiConversation').binding(id).target('chat').getSnapshot()?.nodes.values()
        .filter(n => n.data?.source?.dshRecollection).map(n => ({ kind: n.kind, data: n.data })); }
      catch (error) { if (error.message.includes('unknown session')) return []; throw error; }
    }, agent.id);
    await check('locale dictionaries work, but native third-party command menu and hint stay untranslated', async () => {
      evidence.localeRegistration = await page.evaluate(() => {
        const locale = window.__recallProbe.get('locale');
        locale.register('rc4a-probe', { en: { description: 'Probe English', hint: 'Enter what you want to recall' }, zh: { description: '探针中文', hint: '输入你想要回想的内容' } });
        locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' });
        let duplicateError;
        try { locale.register('conversation', 'zh', { 'hint.rc4a-probe': '输入你想要回想的内容' }); } catch (error) { duplicateError = error.message; }
        return { duplicateError };
      });
      assert.match(evidence.localeRegistration.duplicateError, /duplicate|already|registered/i);
      evidence.locales = [];
      for (const language of ['zh', 'en', 'fr']) {
        const translated = await page.evaluate(language => { const locale = window.__recallProbe.get('locale'); locale.setLocale(language); return locale.bind('rc4a-probe')('description'); }, language);
        assert.equal(translated, language === 'zh' ? '探针中文' : 'Probe English');
        await composer().fill('/rc4a-probe');
        const row = page.getByText('RC4A probe description', { exact: true }); await row.waitFor(); await row.click();
        await until(async () => (await composer().ariaSnapshot()).includes('[RC4A input]'), 'native hint shown inside composer');
        evidence.locales.push({ language, translated, menu: 'RC4A probe description', hint: '[RC4A input]' });
        await page.screenshot({ path: join(output, `locale-${language}.png`), fullPage: true });
        await composer().fill('');
      }
    });
    await check('same-name client contribution rejects rather than localizing a Host command', async () => {
      evidence.collision = await page.evaluate(async id => {
        const command = window.__recallProbe.get('commandUi');
        const off = command.register({ name: 'rc4a-probe', description: () => '探针中文', available: () => true, ui: { kind: 'action', run() {} } });
        try { await command.candidates({ sessionId: id }, { query: '', position: 'leading', signal: new AbortController().signal }); return 'unexpected success'; }
        catch (error) { return error.message; } finally { off(); }
      }, agent.id);
      assert.match(evidence.collision, /collides with a host command/);
    });
    await check('dsh-context style trigger source localizes its own row but coexists with the native Host row', async () => {
      await page.evaluate(() => {
        const ctx = window.__recallProbe;
        window.__rc4aSourceOff = ctx.get('inputTriggers').registerSource({ trigger: '/', name: 'rc4a-context-reference', order: 1,
          candidates: async () => [{ name: 'rc4a-probe', description: ctx.get('locale').bind('rc4a-probe')('description') }],
          onPick: () => undefined });
      });
      evidence.contextStyleMenu = [];
      try {
        for (const language of ['zh', 'en']) {
          await page.evaluate(language => window.__recallProbe.get('locale').setLocale(language), language);
          await composer().fill('/rc4a-probe');
          await page.getByText(language === 'zh' ? '探针中文' : 'Probe English', { exact: true }).waitFor();
          await page.getByText('RC4A probe description', { exact: true }).waitFor();
          const rows = page.getByRole('option').filter({ hasText: 'rc4a-probe' });
          assert.equal(await rows.count(), 2);
          evidence.contextStyleMenu.push({ language, rows: await rows.allTextContents() });
          await page.screenshot({ path: join(output, `context-style-${language}.png`), fullPage: true });
          await composer().press('Escape'); await composer().fill('');
        }
      } finally { await page.evaluate(() => window.__rc4aSourceOff()); }
    });
    async function send(input) {
      const before = evidence.submitted.length;
      await composer().fill(`/rc4a-probe${input ? ` ${input}` : ''}`); await composer().press('Escape'); await composer().press('Enter');
      await until(() => evidence.submitted.length === before + 1, 'browser command submission');
    }
    await check('structured source reaches admitted user/steering Chat nodes, but default bubble and copy expose full input', async () => {
      h.model.replies.push({ sessionId: agent.id, text: 'RC4a bare reply' });
      await send(''); await agent.whenIdle();
      h.model.replies.push({ sessionId: agent.id, text: 'RC4a targeted reply' });
      await send('我们最先讨论的问题'); await agent.whenIdle();
      await until(async () => (await nodes())?.length === 2, 'marked Chat nodes');
      evidence.chatNodes = await nodes();
      assert.equal(evidence.chatNodes[0].data.source.dshRecollection.userInput, '');
      assert.equal(evidence.chatNodes[1].data.source.dshRecollection.userInput.trim(), '我们最先讨论的问题');
      assert.ok(evidence.chatNodes.every(n => n.data.source.kind === 'user'));
      const bubble = page.locator('[class*="userRow"]').filter({ hasText: '我们最先讨论的问题' });
      assert.match(await bubble.innerText(), /RC4A_INTERNAL_INSTRUCTION/);
      await bubble.getByRole('button').first().click();
      evidence.clipboard = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(evidence.clipboard, /RC4A_INTERNAL_INSTRUCTION/);
      await page.screenshot({ path: join(output, 'default-full-input.png'), fullPage: true });
    });
    await check('keyed renderer can hide admitted rows, but pending steering bypasses that renderer', async () => {
      // Deliberately minimal renderer; not a proposed replacement for ordinary native user rows.
      await page.evaluate(() => {
        const slots = window.__recallProbe.get('slots');
        window.__rc4aRenderOff = ['user', 'steering'].map(key => slots.register({ name: 'conversation.chat.node', key, priority: -1 }, ({ node }) => {
          const marker = node.data.source?.dshRecollection;
          return marker ? marker.userInput || null : node.data.content.map(b => b.text ?? '').join('');
        }));
      });
      await until(async () => !(await page.locator('body').innerText()).includes('RC4A_INTERNAL_INSTRUCTION'), 'admitted instructions hidden by renderer');
      const gate = deferred(), entered = deferred(); release = gate.resolve;
      const engine = ctx.recallTools.search, run = engine.run.bind(engine);
      restore = replace(engine, 'run', async (...args) => { entered.resolve(); await gate.promise; return run(...args); });
      h.model.replies.push({ sessionId: agent.id, calls: [{ id: 'rc4a-search', name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }] }, { sessionId: agent.id, text: 'RC4a evidence reply' });
      await send('opening target'); await entered.promise;
      await send('pending target');
      const pending = page.locator('[data-pending-steering="true"]');
      await pending.waitFor(); assert.match(await pending.innerText(), /RC4A_INTERNAL_INSTRUCTION/);
      evidence.pending = structuredClone(agent.inbox.nextStep);
      assert.equal(evidence.pending.length, 1); assert.equal(evidence.pending[0].source.dshRecollection.userInput.trim(), 'pending target');
      await pending.getByRole('button').first().click();
      evidence.pendingClipboard = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(evidence.pendingClipboard, /RC4A_INTERNAL_INSTRUCTION/);
      await page.screenshot({ path: join(output, 'pending-bypasses-node-renderer.png'), fullPage: true });
      gate.resolve(); await agent.whenIdle(); release = undefined; restore(); restore = undefined;
      await pending.waitFor({ state: 'hidden' });
      await until(async () => !(await page.locator('body').innerText()).includes('RC4A_INTERNAL_INSTRUCTION'), 'admitted steering now hidden');
      evidence.finalChatNodes = await nodes();
      assert.equal(evidence.finalChatNodes.length, 4);
    });
    await check('experimental entry mutation delegates native rows and localizes hints without changing command submission', async () => {
      evidence.slotEntries = await page.evaluate(async () => {
        window.__rc4aRenderOff.forEach(off => off());
        const ctx = window.__recallProbe, slots = ctx.get('slots');
        window.__rc4aEntryErrors = [];
        slots.onEntryError((key, entry, error) => window.__rc4aEntryErrors.push({ key, error: error.message }));
        const React = await ctx.modules.import('react', '', {});
        const entries = ['conversation.chat.node', 'conversation.chat.flow', 'conversation.composer.bar'].flatMap(name => slots.entriesOfSlot(name)
          .filter(entry => name !== 'conversation.chat.node' || ['user', 'steering'].includes(entry.options.key)).map(entry => ({ entry, name })));
        const description = entries.map(({ entry, name }) => ({ keys: Object.keys(entry), options: Object.keys(entry.options), name, key: entry.options.key }));
        window.__rc4aEntries = description;
        window.__rc4aDelegateOff = entries.map(({ entry, name }) => {
          const original = entry.component;
          const wrapped = props => {
            let projected = props;
            if (name === 'conversation.composer.bar') {
              projected = { ...props, t: (key, ...args) => key === 'hint.rc4a-probe'
                ? ctx.get('locale').getLocale().active === 'zh' ? '输入你想要回想的内容' : 'Enter what you want to recall'
                : props.t(key, ...args) };
            } else if (name === 'conversation.chat.flow') {
              projected = { ...props, pendingInputs: props.pendingInputs.flatMap(item => {
                const marker = item.source?.dshRecollection;
                return !marker ? [item] : !marker.userInput ? [] : [{ ...item, content: [{ type: 'text', text: marker.userInput }] }];
              }) };
            } else {
              const marker = props.node.data.source?.dshRecollection;
              if (marker) {
                if (!marker.userInput) return null;
                projected = { ...props, node: { ...props.node, data: { ...props.node.data, content: [{ type: 'text', text: marker.userInput }] } } };
              }
            }
            return React.createElement(original, projected);
          };
          // Investigation only: unlike register(), mutating an inspected entry is not a documented decorator API.
          entry.component = wrapped;
          const refresh = () => { const off = slots.register({ name, ...entry.options, priority: 999 }, () => null); off(); };
          refresh();
          return () => { if (entry.component === wrapped) { entry.component = original; refresh(); } };
        });
        return description;
      });
      await until(async () => !(await page.locator('body').innerText()).includes('RC4A_INTERNAL_INSTRUCTION'), 'delegating renderer hides instruction');
      const bubble = page.locator('[class*="userRow"]').filter({ hasText: '我们最先讨论的问题' });
      await bubble.getByRole('button').first().click();
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())).trim(), '我们最先讨论的问题');
      const ordinary = page.locator('[class*="userRow"]').filter({ hasText: 'needle historical proof' });
      await ordinary.getByRole('button').first().click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'needle historical proof');
      for (const language of ['zh', 'en', 'fr']) {
        await page.evaluate(language => window.__recallProbe.get('locale').setLocale(language), language);
        await composer().fill('/rc4a-probe'); await page.getByText('RC4A probe description', { exact: true }).click();
        await until(async () => (await composer().ariaSnapshot()).includes(language === 'zh' ? '输入你想要回想的内容' : 'Enter what you want to recall'), 'delegated native input hint');
        await composer().fill('');
      }
      await page.screenshot({ path: join(output, 'delegating-wrappers.png'), fullPage: true });
    });
    await check('experimental flow wrapper hides bare pending input and preserves targeted pending copy, tools and native budget', async () => {
      const gate = deferred(), entered = deferred(); release = gate.resolve;
      const engine = ctx.recallTools.search, run = engine.run.bind(engine);
      restore = replace(engine, 'run', async (...args) => { entered.resolve(); await gate.promise; return run(...args); });
      h.model.replies.push({ sessionId: agent.id, calls: [{ id: 'rc4a-wrapper-search', name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }] }, { sessionId: agent.id, text: 'RC4a wrapper evidence reply' });
      await send('wrapper opening target'); await entered.promise;
      evidence.openingId = evidence.submitted.at(-1).id;
      await send('');
      assert.equal(agent.inbox.nextStep.length, 1);
      await until(async () => await page.locator('[data-pending-steering="true"]').count() === 0, 'no bare pending bubble');
      await send('only pending user');
      const pending = page.locator('[data-pending-steering="true"]');
      await pending.waitFor(); assert.equal(await pending.count(), 1);
      assert.equal((await pending.innerText()).trim(), 'only pending user');
      await pending.getByRole('button').first().click();
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())).trim(), 'only pending user');
      assert.equal((await page.locator('body').innerText()).includes('RC4A_INTERNAL_INSTRUCTION'), false);
      await page.screenshot({ path: join(output, 'wrapped-pending.png'), fullPage: true });
      gate.resolve(); await agent.whenIdle(); release = undefined; restore(); restore = undefined;
      await pending.waitFor({ state: 'hidden' });
      await page.getByText('RC4a wrapper evidence reply', { exact: true }).waitFor();
      evidence.finalChatNodes = await nodes();
      assert.equal(evidence.finalChatNodes.length, 7);
      assert.deepEqual(await page.evaluate(() => window.__rc4aEntryErrors), []);
    });
    await check('experimental wrapper teardown restores native renderers without changing admitted messages', async () => {
      await page.evaluate(() => window.__rc4aDelegateOff.reverse().forEach(off => off()));
      await until(async () => (await page.locator('body').innerText()).includes('RC4A_INTERNAL_INSTRUCTION'), 'original renderers restored');
      assert.deepEqual(await nodes(), evidence.finalChatNodes);
      assert.deepEqual(await page.evaluate(() => window.__rc4aEntryErrors), []);
    });
    await check('history reload retains structured source and full model text, without an adapter the prompt is visible again', async () => {
      await page.reload(); await page.waitForFunction(() => Boolean(window.__recallProbe?.recallClient));
      await until(async () => (await nodes())?.length === evidence.submitted.length, 'reloaded Chat nodes');
      evidence.reloadedNodes = await nodes();
      assert.deepEqual(evidence.reloadedNodes, evidence.finalChatNodes);
      await until(async () => (await page.locator('body').innerText()).includes('RC4A_INTERNAL_INSTRUCTION'), 'unmodified renderer restored');
    });
    assert.deepEqual(evidence.pageErrors, []);
  } catch (error) {
    if (page && !page.isClosed()) {
      evidence.slotEntries ??= await page.evaluate(() => window.__rc4aEntries);
      evidence.entryErrors = await page.evaluate(() => window.__rc4aEntryErrors);
      await writeFile(join(output, 'failure.txt'), await page.locator('body').ariaSnapshot());
      await writeFile(join(output, 'failure.html'), await page.content());
      await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
    }
    throw error;
  } finally { release?.(); restore?.(); await browser?.close(); }
}
