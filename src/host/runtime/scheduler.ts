import type { PageSnapshot } from '../state/pages.js';

export type PreparationWorkKind = 'history' | 'hash' | 'operation';
/** The combined order is shared by history, reference sampling and active calls. */
export function preparationPriority(kind: PreparationWorkKind, current: boolean, waiting: boolean): 0 | 1 | 2 | 3 | 4 {
  if (kind === 'hash') return current ? 1 : 3;
  return current ? 0 : waiting ? 2 : 4;
}
export interface ScheduledPreparation {
  readonly sessionId: string;
  readonly order: number;
  readonly waiters: number;
  readonly kind?: PreparationWorkKind;
}
/** Only trusted Host code attaches this live view of an existing operation task. */
export interface OperationTicket { readonly sessionId: string; readonly order: number; priority(): number; }

/** Pure selection policy. Task identity is one fixed demand, not a permanent session privilege. */
export class PreparationScheduler<T extends ScheduledPreparation> {
  private readonly current = new Set<T>();
  private previous: T | undefined;
  private activation = 0;

  /** Observe every accepted page transition, even in the middle of a batch. */
  update(tasks: readonly T[], pages: readonly PageSnapshot[]): void {
    const active = pages.filter(page => page.active && page.view?.sessionId)
      .sort((a, b) => b.activationOrder - a.activationOrder);
    const latest = active[0];
    if (latest && latest.activationOrder > this.activation) {
      this.activation = latest.activationOrder;
      // A genuine newer activation takes over immediately, including a selection
      // with no pending history. Heartbeats never create an activation edge.
      this.current.clear();
      for (const task of tasks) if (task.sessionId === latest.view!.sessionId) this.current.add(task);
    }
    for (const task of this.current) if (!tasks.includes(task)) this.current.delete(task);
    const retainedSession = this.current.values().next().value?.sessionId;
    if (retainedSession && active.some(page => page.view!.sessionId === retainedSession)) {
      for (const task of tasks) if (task.sessionId === retainedSession) this.current.add(task);
    }
    if (!this.current.size) {
      for (const page of active) {
        const task = tasks.find(task => task.sessionId === page.view!.sessionId);
        if (task) { for (const peer of tasks) if (peer.sessionId === task.sessionId) this.current.add(peer); break; }
      }
    }
    // Inactive/closed/expired declarations do not revoke an existing fixed task.
  }

  priority(task: T): 0 | 1 | 2 | 3 | 4 {
    return preparationPriority(task.kind ?? 'history', this.current.has(task), task.waiters > 0);
  }

  select(tasks: readonly T[], pages: readonly PageSnapshot[]): T | undefined {
    this.update(tasks, pages);
    let next: T | undefined;
    for (const task of tasks) {
      if (!next || this.priority(task) < this.priority(next)
        || (this.priority(task) === this.priority(next) && task.order < next.order)) next = task;
    }
    // Equal-level arrivals never interrupt the current fixed task. After a
    // higher-level interruption, original FIFO order selects the next peer.
    if (next && this.previous && tasks.includes(this.previous) && this.priority(this.previous) === this.priority(next)) next = this.previous;
    this.previous = next;
    return next;
  }

  finish(task: T): void {
    this.current.delete(task);
    if (this.previous === task) this.previous = undefined;
  }
  clear(): void { this.current.clear(); this.previous = undefined; this.activation = 0; }
}
