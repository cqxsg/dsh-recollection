import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'recall/re-register': { readonly reason: 'host-changed' | 'expired' | 'unknown-registration' };
    'recall/invalid-report': { readonly field: string };
    'recall/page-conflict': { readonly reason: 'owner' | 'registration-order' };
  }
}

export const REPORT_INTERVAL_MS = 5_000;
export const PAGE_EXPIRY_MS = 60_000;
export const REPORT_TIMEOUT_MS = 5_000;

/** Complete page state; ambiguous mainView ownership never selects a session. */
export interface ViewState {
  readonly sessionId: SessionId | null;
  readonly selection: 'selected' | 'none' | 'ambiguous';
  readonly conversationVisible: boolean;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly closed: boolean;
}

/** Opening does not assert a view or activate any session. */
export interface OpenPageRequest {
  readonly protocolVersion: 1;
  readonly pageId: string;
  readonly registrationSequence: number;
  readonly sessionId: SessionId | null;
}

/** Host-issued capability, bound to this page and the authenticated principal. */
export interface PageRegistration {
  readonly hostEpoch: string;
  readonly registrationId: string;
}

export interface ViewReport {
  readonly protocolVersion: 1;
  readonly pageId: string;
  readonly hostEpoch: string;
  readonly registrationId: string;
  readonly sequence: number;
  /** Page-lifetime activation edges, retained across coalescing/reconnection. */
  readonly activationSequence: number;
  readonly view: ViewState;
}

export interface ViewReceipt {
  readonly accepted: boolean;
  readonly reason: 'accepted' | 'stale';
  readonly hostEpoch: string;
}

export function isActiveView(view: ViewState | null): boolean {
  return view !== null && !view.closed && view.selection === 'selected'
    && view.sessionId !== null && view.conversationVisible && view.visible && view.focused;
}
