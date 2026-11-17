import assert from 'node:assert/strict';
import { join } from 'node:path';

// One option definition for the parent launcher and the isolated child.
export function readWebOptions(args) {
  const commandBrowser = args.includes('--recall-command-browser');
  const browser = args.includes('--browser');
  const history = args.includes('--history');
  const range = args.includes('--range');
  const records = args.includes('--records');
  const preparation = args.includes('--preparation');
  const scheduling = args.includes('--scheduling');
  const toolsBrowser = args.includes('--tools-browser');
  const protocol = args.includes('--protocol');
  const cursors = args.includes('--cursors');
  const referencePages = args.includes('--reference-pages');
  const compactOutput = args.includes('--compact-output');
  const delivery = args.includes('--delivery');
  const budget = args.includes('--budget');
  const search = args.includes('--search');
  const read = args.includes('--read');
  const attachments = args.includes('--attachments');
  const hashes = args.includes('--hashes');
  const attachmentScheduling = args.includes('--attachment-scheduling');
  const attachmentRead = args.includes('--attachment-read');
  const recallBrowser = args.includes('--recall-browser');
  const recall = args.includes('--recall') || recallBrowser;
  const recallReview = args.includes('--recall-review');
  const concurrency = args.includes('--recall-concurrency');
  const deadlines = args.includes('--recall-deadlines');
  const tools = args.includes('--tools') || toolsBrowser;
  const smoke = args.includes('--smoke') || commandBrowser || browser || history || range || records || preparation || scheduling || tools || protocol || cursors || referencePages || compactOutput || delivery || budget || search || read || recall || recallReview || concurrency || deadlines || attachments || hashes || attachmentScheduling || attachmentRead;
  return { commandBrowser, browser, history, range, records, preparation, scheduling, toolsBrowser, protocol, cursors, referencePages, compactOutput, delivery, budget, search, read, attachments, hashes, attachmentScheduling, attachmentRead, recallBrowser, recall, recallReview, concurrency, deadlines, tools, smoke };
}

export function webLabel(options) {
  const { browser, history, range, records, preparation, scheduling, toolsBrowser, tools, smoke } = options;
  return browser ? 'web-browser' : toolsBrowser ? 'tools-browser' : tools ? 'tools' : scheduling ? 'scheduling' : preparation ? 'preparation' : records ? 'records' : range ? 'range' : history ? 'history' : smoke ? 'web-smoke' : 'web';
}

export function webPatch(options) {
  const { commandBrowser, browser, toolsBrowser, delivery, budget, search, read, attachments, hashes, attachmentScheduling, recallBrowser, recall, tools, smoke } = options;
  return [
    ...(delivery ? [{ id: 'compaction-basic', disabled: false, config: { thresholdRatio: 20000 / 131072, retainTokens: 1024 } }, { id: 'tool-result-pruner', disabled: false }] : []),
    ...(smoke ? [{ id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } }] : []),
    { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { diagnostics: tools, enabled: !(budget || search || read || hashes || attachments || attachmentScheduling) } }] },
    ...(browser || toolsBrowser || recallBrowser || commandBrowser ? [{ insert: [{ id: 'recall-test-probe', name: new URL('../fixtures/browser-probe/index.mjs', import.meta.url).href }] }] : []),
  ];
}

export function webArguments(options) {
  const { commandBrowser, browser, history, range, records, preparation, scheduling, toolsBrowser, protocol, cursors, referencePages, compactOutput, delivery, budget, search, read, attachments, hashes, attachmentScheduling, attachmentRead, recallBrowser, recall, recallReview, concurrency, deadlines, tools, smoke } = options;
  return [
    ...(smoke ? ['--smoke'] : []),
    ...(commandBrowser ? ['--recall-command-browser'] : []),
    ...(browser ? ['--browser'] : []),
    ...(history ? ['--history'] : []),
    ...(range ? ['--range'] : []),
    ...(records ? ['--records'] : []),
    ...(preparation ? ['--preparation'] : []),
    ...(scheduling ? ['--scheduling'] : []),
    ...(tools ? ['--tools'] : []),
    ...(toolsBrowser ? ['--tools-browser'] : []),
    ...(protocol ? ['--protocol'] : []),
    ...(cursors ? ['--cursors'] : []),
    ...(referencePages ? ['--reference-pages'] : []),
    ...(compactOutput ? ['--compact-output'] : []),
    ...(delivery ? ['--delivery'] : []),
    ...(budget ? ['--budget'] : []),
    ...(search ? ['--search'] : []),
    ...(read ? ['--read'] : []),
    ...(attachments ? ['--attachments'] : []),
    ...(hashes ? ['--hashes'] : []),
    ...(attachmentScheduling ? ['--attachment-scheduling'] : []),
    ...(attachmentRead ? ['--attachment-read'] : []),
    ...(recall ? ['--recall'] : []),
    ...(recallReview ? ['--recall-review'] : []),
    ...(concurrency ? ['--recall-concurrency'] : []),
    ...(recallBrowser ? ['--recall-browser'] : []),
    ...(deadlines ? ['--recall-deadlines'] : []),
  ];
}

export function webTimeout(options) {
  const { commandBrowser, browser, history, range, records, preparation, scheduling, toolsBrowser, cursors, referencePages, compactOutput, delivery, budget, search, read, attachmentRead, recallBrowser, recall, recallReview, concurrency, deadlines, tools } = options;
  return commandBrowser ? 240_000 : concurrency ? 240_000 : browser || recallBrowser || recallReview || attachmentRead || cursors || referencePages || compactOutput || delivery ? 180_000 : toolsBrowser || recall || deadlines ? 120_000 : history || range || records || preparation || scheduling || tools || budget || search || read ? 90_000 : 45_000;
}

export async function verifyWebScenarios(runtime, options) {
  const { commandBrowser, browser, history, range, records, preparation, scheduling, toolsBrowser, protocol, cursors, referencePages, compactOutput, delivery, budget, search, read, attachments, hashes, attachmentScheduling, attachmentRead, recallBrowser, recall, recallReview, concurrency, deadlines, tools } = options;
  const { DIAGNOSTIC_TOOL_NAME } = await import('../../lib/index.js');
  const { ctx } = runtime;
  assert.equal(ctx.recallPages.status.implementation, 'phase-5-evaluation');
  assert.ok(ctx.recallHistory);
  assert.ok(ctx.recallPreparation);
  if (!tools) {
    assert.equal(ctx.get('recallDiagnostics'), undefined);
    assert.equal(ctx.get('recallLedger'), undefined);
    assert.equal(ctx.tools.get(DIAGNOSTIC_TOOL_NAME), undefined);
    assert.equal(ctx.tools.schemas().some(tool => tool.name === DIAGNOSTIC_TOOL_NAME), false);
    const absent = await ctx.tools.execute({ name: DIAGNOSTIC_TOOL_NAME, callId: 'disabled-diagnostic', arguments: {}, signal: new AbortController().signal });
    assert.equal(absent.error.info.code, 'UNKNOWN_TOOL');
  }
  assert.equal(ctx.spillStore.root, join(process.env.DSH_HOME, 'spills'));
  assert.equal(ctx.spillStore.config.cleanupPeriodDays, 0);
  const base = `http://127.0.0.1:${ctx.webServer.port}/`;
  const unauthorized = await fetch(base, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  const login = await fetch(ctx.connection.authenticatedUrl(base), {
    redirect: 'manual', signal: AbortSignal.timeout(5000),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  await login.text();
  const response = await fetch(base, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /dsh-recollection/);
  const row = ctx.clientModules.graph().entries.find(row => row.id === 'dsh-recollection');
  assert.ok(row);
  const bundle = await fetch(new URL(row.url, base), { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(bundle.status, 200);
  assert.match(await bundle.text(), /window\.__ModuleLoader__\.load/);
  if (browser) {
    const { verifyWeb } = await import('../client/web-browser.mjs');
    await verifyWeb(ctx, base);
  }
  if (history) {
    const { verifyHistory } = await import('../history/history-native.mjs');
    await verifyHistory(ctx);
  }
  if (range) {
    const { verifyRange } = await import('../history/range-native.mjs');
    await verifyRange(ctx);
  }
  if (records) {
    const { verifyRecords } = await import('../history/records-native.mjs');
    await verifyRecords(ctx);
  }
  if (preparation) {
    const { verifyPreparation } = await import('../history/preparation-native.mjs');
    await verifyPreparation(ctx);
  }
  if (scheduling) {
    const { verifyScheduling } = await import('../runtime/scheduling-native.mjs');
    await verifyScheduling(ctx);
  }
  if (tools) {
    const { verifyDiagnosticTools } = await import('../integration/diagnostics-native.mjs');
    await verifyDiagnosticTools(ctx, toolsBrowser ? base : undefined);
  }
  if (protocol) {
    const { verifyProtocol } = await import('../integration/protocol-native.mjs');
    await verifyProtocol(ctx);
  }
  if (delivery) {
    const { verifyDelivery } = await import('../state/delivery-native.mjs');
    await verifyDelivery(ctx);
  }
  if (compactOutput) {
    const { verifyCompactOutput } = await import('../state/compact-output-native.mjs');
    await verifyCompactOutput(ctx);
  }
  if (referencePages) {
    const { verifyReferencePages } = await import('../state/reference-pages-native.mjs');
    await verifyReferencePages(ctx);
  }
  if (cursors) {
    const { verifyCursors } = await import('../state/cursors-native.mjs');
    await verifyCursors(ctx);
  }
  if (budget) {
    const { verifyBudget } = await import('../state/budget-native.mjs');
    await verifyBudget(ctx);
  }
  if (search) {
    const { verifySearch } = await import('../retrieval/search-native.mjs');
    await verifySearch(ctx);
  }
  if (read) {
    const { verifyRead } = await import('../retrieval/read-native.mjs');
    await verifyRead(ctx);
  }
  if (attachments) {
    const { verifyAttachments } = await import('../attachments/attachments-native.mjs');
    await verifyAttachments(ctx);
  }
  if (hashes) {
    const { verifyHashes } = await import('../attachments/hash-native.mjs');
    await verifyHashes(ctx);
  }
  if (attachmentScheduling) {
    const { verifyAttachmentScheduling } = await import('../attachments/attachment-scheduling-native.mjs');
    await verifyAttachmentScheduling(ctx);
  }
  if (attachmentRead) {
    const { verifyAttachmentRead } = await import('../attachments/attachment-read-native.mjs');
    await verifyAttachmentRead(ctx);
  }
  if (recall) {
    const { verifyRecall } = await import('../integration/recall-native.mjs');
    await verifyRecall(ctx, recallBrowser ? base : undefined);
  }
  if (commandBrowser) {
    const { verifyRecallCommandBrowser } = await import('../client/recall-command-browser.mjs');
    await verifyRecallCommandBrowser(ctx, base);
  }
  if (recallReview) {
    const { verifyRecallReviewSuite } = await import('../integration/recall-review-native.mjs');
    await verifyRecallReviewSuite(ctx);
  }
  if (concurrency) {
    const { verifyPageConcurrency } = await import('../integration/page-concurrency-native.mjs');
    await verifyPageConcurrency(ctx);
  }
  if (deadlines) {
    const { verifyRecallDeadlines } = await import('../integration/recall-deadline-native.mjs');
    await verifyRecallDeadlines(ctx);
  }
}

export function verifyWebShutdown(ctx) {
  assert.equal(ctx.get('recallPages'), undefined);
  assert.equal(ctx.get('recallHistory'), undefined);
  assert.equal(ctx.get('recallPreparation'), undefined);
  assert.equal(ctx.get('recallDiagnostics'), undefined);
  assert.equal(ctx.get('recallLedger'), undefined);
  console.log('PASS: isolated rc.4 Web profile, Host scope, index, Client bundle, spill config and shutdown.');
}
