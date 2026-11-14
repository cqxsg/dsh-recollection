/** Build capability is distinct from the actual loaded tools and per-agent budget. */
export const BASELINE = Object.freeze({
  dshVersion: '0.2.1-rc.4',
  implementation: 'phase-5-evaluation',
  pageReportsAvailable: true,
  recallAvailable: true as boolean,
} as const);

export type BaselineStatus = typeof BASELINE;
