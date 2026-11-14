export function semanticPerformanceResult(tools) {
  return tools.map(({ name, status, code, value }) => ({ name, status, code,
    scanComplete: value?.scanComplete, scannedRecords: value?.scannedRecords, totalHits: value?.totalHits,
    items: value?.items?.map(item => ({ content: item.content, contentComplete: item.contentComplete,
      role: item.source?.role, kind: item.source?.kind, attachments: item.attachments?.map(a => ({ name: a.name, mimeType: a.mimeType })) })),
    attachments: value?.attachmentResults?.map(a => ({ state: a.state, version: a.version?.state })) }));
}
