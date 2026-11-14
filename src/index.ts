import type { Context } from '@deepseek-ai/cordis';
import { RecallPageState } from './host/state/page-state.js';
import { RecallHistoryService } from './host/history/history.js';
import { RecallPreparationService } from './host/history/preparation.js';
import { RecallMemoryService } from './host/runtime/memory.js';
import { RecallDiagnosticTools } from './host/diagnostics.js';
import { RecallCallLedger } from './host/state/ledger.js';
import { RecallBudgetService } from './host/state/budget.js';
import { RecallCursorStore } from './host/state/cursors.js';
import { RecallReferenceStore } from './host/state/reference-store.js';
import { RecallToolsService } from './host/tools.js';
import { loadRecallConfig, MAX_TIMER_MS } from './host/runtime/config.js';
import { RecallHashLedger } from './host/attachments/hash-ledger.js';
import { RecallAttachmentService } from './host/attachments/attachment-service.js';
import z from '@deepseek-ai/schemastery';

export { RecallPageState };
export { RecallMemoryService, RecallMemoryBudget, MemoryHolder, retainedBytes, RECALL_MEMORY_LIMITS } from './host/runtime/memory.js';
export { RecallHistoryService, RecallHistoryError, type HistorySnapshot, type HistoryScopeOptions } from './host/history/history.js';
export { RecallDiagnosticTools, DIAGNOSTIC_TOOL_NAME } from './host/diagnostics.js';
export { RecallCallLedger, diagnosticLedgerSpec, diagnosticLedgerRecord, interactionKey } from './host/state/ledger.js';
export { loadRecallConfig, recallConfig, type RecallConfig } from './host/runtime/config.js';
export { searchInput, readInput, parseRequest, recallResult, nativeSchema, inputSchema, RecallError, type RecallResult, type ResultItem, type SearchTerms } from './host/protocol.js';
export { queryTermsId, logicalQueryId } from './host/retrieval/references.js';
export { RecallReferenceStore, recordLocator, recordLocatorSchema, recordKey, referenceHandle, referencePlaceholder, referenceRecord, referenceDomainSpec, type RecordLocator, type ReferenceRecord } from './host/state/reference-store.js';
export { RecallCursorStore, cursorDomainSpec, cursorRecord, cursorPageId, cursorPlaceholder, type CursorTarget, type CursorRecord } from './host/state/cursors.js';
export { effectiveSpill, pageBudget, renderRecall, renderedTokens, verifyOutput } from './host/retrieval/output.js';
export { RecallBudgetService, businessLedgerRecord, businessLedgerSpec, type Reservation, type Operation } from './host/state/budget.js';
export { CallTimeline } from './host/runtime/deadline.js';
export { RecallCallController, type ControlOptions, type BusinessPage } from './host/runtime/control.js';
export { NativeMatcher, RG_VERSION, recordDocument, type RecordMatch, type MatchSpan } from './host/retrieval/matcher.js';
export { POOL_LIMITS, WORKER_LIMITS } from './host/retrieval/worker.js';
export { startPerformanceCapture, performanceDiagnostics, type PerformanceCapture } from './host/runtime/performance.js';
export { RecallSearchEngine, SEARCH_MATCH_BATCH } from './host/retrieval/search.js';
export { RecallReadEngine } from './host/retrieval/read.js';
export { fileMentions, blockAttachments, recordAttachments, attachmentMetadata, accessAttachment, fileFailure, type AttachmentSource, type AttachmentAccess } from './host/attachments/attachments.js';
export { attachmentItem, attachmentResult, type AttachmentItem, type AttachmentResult } from './host/protocol.js';
export { HashComputation, hashCurrent, HASH_CHUNK_BYTES, HASH_SLICE_MS } from './host/attachments/hashing.js';
export { RecallHashLedger, hashRecord, hashLedgerSpec, hashKey, hashSource, type HashRecord, type HashSource } from './host/attachments/hash-ledger.js';
export { RecallAttachmentService, nativeHashSources, recordHashSource } from './host/attachments/attachment-service.js';
export { RecallToolsService, SEARCH_DESCRIPTION, READ_DESCRIPTION, RECALL_USAGE } from './host/tools.js';
export { indexHistoryRecords, fingerprintHistory } from './host/history/records.js';
export { currentInteraction, resolveCallIdentity } from './host/runtime/identity.js';
export { classifyHistoryRange, RecallRangeError, type HistoryRange, type RangeSource, type RangeBlock, type RangeExitReason } from './host/history/range.js';
export { HistoryRecordCache, RecallRecordsError, type CanonicalRecord, type CanonicalBlock, type RecordOrigin, type RecordTool, type RecordToolPair, type RecordSelection, type RecordBatchOptions, type PreparedRecordBatch, type RecordBlockCoverage } from './host/history/records.js';
export { RecallPreparationService, RecallPreparationError, type PreparedSession, type PreparationStatus, type PreparationOptions, type PreparationTimings } from './host/history/preparation.js';

export interface Config {
  diagnostics: boolean;
  diagnosticTimeoutMs: number;
  enabled: boolean;
  prewarm: boolean;
  attachmentHashing: boolean;
  recall: unknown;
}

export const Config: z<Config> = z.object({
  diagnostics: z.boolean().default(false),
  diagnosticTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(5_000),
  enabled: z.boolean().default(true),
  prewarm: z.boolean().default(true),
  attachmentHashing: z.boolean().default(true),
  recall: z.any().default({}),
});

/** Explicit registration also supports file-URL Loader entries in rc.4. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const options = loadRecallConfig(config.recall);
  ctx.plugin(RecallPageState, config.prewarm);
  ctx.plugin(RecallMemoryService, options);
  ctx.plugin(RecallHistoryService);
  ctx.plugin(RecallPreparationService);
  if (config.enabled) {
    await ctx.plugin(RecallBudgetService, options);
    await ctx.plugin(RecallReferenceStore);
    await ctx.plugin(RecallCursorStore);
    await ctx.plugin(RecallToolsService, options);
  }
  // Each optional service owns its normal Cordis lifetime. Observe startup
  // rejection without making core activation wait for optional storage/I/O.
  const optional = (name: string, mount: () => PromiseLike<unknown>) => {
    const failed = (error: unknown) => ctx.logger.warn('Recall %s unavailable: %s', name, error instanceof Error ? error.message : String(error));
    try { void Promise.resolve(mount()).catch(failed); } catch (error) { failed(error); }
  };
  if (config.enabled && config.attachmentHashing) {
    optional('attachment hashing', () => ctx.plugin(RecallHashLedger, options));
    optional('attachment admission', () => ctx.plugin(RecallAttachmentService));
  }
  if (config.diagnostics) {
    optional('diagnostic ledger', () => ctx.plugin(RecallCallLedger));
    optional('diagnostic tools', () => ctx.plugin(RecallDiagnosticTools, { timeoutMs: config.diagnosticTimeoutMs }));
  }
  if (config.prewarm) {
    try {
      // A separate built module: core import/loading must not resolve Typert.
      const prewarm = await import(new URL('./prewarm.js', import.meta.url).href);
      await ctx.plugin(prewarm);
    } catch (error) {
      ctx.get('recallPages')?.failed(error);
      ctx.logger.warn('Recall page prewarming unavailable: %s', error instanceof Error ? error.message : String(error));
    }
  }
}
