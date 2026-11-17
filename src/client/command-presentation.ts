import { createElement, useCallback, useMemo, useSyncExternalStore, type ElementType, type ReactNode } from 'react';
import { recallCommandInput, RECALL_INPUT_HINT, RECALL_PREVIEWS } from '../shared/recall-command.js';

// The host exposes entry inspection, not a decorator API. Keep all assumptions
// about its mutable component registrations here; do not mutate Session stores.
type Props = Record<string, any>;
export interface SlotEntry {
  component: ElementType;
  options: { key?: string; id?: string; priority?: number };
}
export interface PresentationSlots {
  entries(name: string): readonly SlotEntry[];
  entriesOfSlot(name: string): readonly SlotEntry[];
  subscribe(name: string, callback: () => void): () => void;
  register(options: { name: string; key?: string; id?: string; priority: number }, component: () => null): () => void;
}
export interface PresentationLocale {
  getLocale(): { active: string };
  subscribe(callback: () => void): () => void;
}
export interface PresentationStatus { ready: boolean; missing: readonly string[]; error?: string }
interface Cell { name: string; key?: string; id?: string; kind: 'message' | 'flow' | 'composer' | 'view' }
const cells: readonly Cell[] = [
  { name: 'conversation.chat.node', key: 'user', kind: 'message' },
  { name: 'conversation.chat.node', key: 'steering', kind: 'message' },
  { name: 'conversation.chat.flow', kind: 'flow' },
  { name: 'conversation.composer.bar', kind: 'composer' },
  { name: 'conversation.view', id: 'chat', kind: 'view' },
];
const label = (cell: Cell) => `${cell.name}${cell.key ? `:${cell.key}` : cell.id ? `:${cell.id}` : ''}`;
const matches = (entry: SlotEntry, cell: Cell) => entry.options?.key === cell.key && entry.options?.id === cell.id;

function messageProps(props: Props): Props | null {
  const input = recallCommandInput(props.node?.data?.source);
  if (input === undefined) return props;
  return input === '' ? null : { ...props, node: { ...props.node, data: { ...props.node.data, content: [{ type: 'text', text: input }] } } };
}

/** Copy only display data. Unmarked pending messages/attachments retain identity. */
function pendingProps(props: Props): Props {
  if (!Array.isArray(props.pendingInputs)) throw new Error('Chat flow has no pendingInputs array');
  let changed = false;
  const pendingInputs = props.pendingInputs.flatMap((item: Props) => {
    const input = recallCommandInput(item.source);
    if (input === undefined) return [item];
    changed = true;
    return input === '' ? [] : [{ ...item, content: [{ type: 'text', text: input }] }];
  });
  return changed ? { ...props, pendingInputs } : props;
}

function componentLike(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value
    && (value.$$typeof === Symbol.for('react.memo') || value.$$typeof === Symbol.for('react.forward_ref')));
}

function viewProjection(previews: unknown) {
  const values = previews && typeof previews === 'object' ? previews as Record<string, unknown> : {};
  const arrays = new WeakMap<object, any[]>(), snapshots = new WeakMap<object, object>();
  const items = (input: any): any => {
    if (!Array.isArray(input)) return input;
    if (arrays.has(input)) return arrays.get(input);
    let changed = false;
    const output = input.map(item => {
      const prompt = values[item.turn];
      if (typeof prompt !== 'string' || item.prompt === prompt) return item;
      changed = true; return { ...item, prompt };
    });
    arrays.set(input, changed ? output : input);
    return changed ? output : input;
  };
  return { items, snapshot: (snapshot: Props) => {
    if (snapshots.has(snapshot)) return snapshots.get(snapshot);
    const projected = { ...snapshot, navigation: { ...snapshot.navigation, items: () => items(snapshot.navigation.items()) } };
    snapshots.set(snapshot, projected); return projected;
  } };
}

interface Binding { entry: SlotEntry; original: ElementType; wrapper: ElementType; active: boolean; cell: Cell }

/** One owner per Slots service; a duplicate mount shares the same wrappers. */
const installations = new WeakMap<PresentationSlots, { refs: number; stop: () => void; listeners: Set<(status: PresentationStatus) => void>; status: PresentationStatus }>();

export function installCommandPresentation(slots: PresentationSlots, locale: PresentationLocale,
  report: (status: PresentationStatus) => void): () => void {
  const existing = installations.get(slots);
  if (existing) {
    existing.refs++; existing.listeners.add(report); report(existing.status);
    let disposed = false;
    return () => { if (disposed) return; disposed = true; existing.listeners.delete(report); if (--existing.refs === 0) existing.stop(); };
  }
  const installation = { refs: 1, stop: () => {}, listeners: new Set([report]), status: { ready: false, missing: cells.map(label) } as PresentationStatus };
  installations.set(slots, installation);
  const bindings = new Map<SlotEntry, Binding>();
  const overridden = new WeakSet<SlotEntry>();
  const off: (() => void)[] = [];
  let stopped = false, reconciling = false;
  const publish = (status: PresentationStatus) => {
    if (JSON.stringify(status) === JSON.stringify(installation.status)) return;
    installation.status = status;
    for (const listener of installation.listeners) listener(status);
  };
  const failure = (error: unknown) => publish({ ready: false, missing: [], error: error instanceof Error ? error.message : String(error) });
  // Registration invalidation uses the host's public notification path. The
  // temporary losing entry is removed synchronously before any render occurs.
  const refresh = (cell: Cell) => {
    const occupied = slots.entries(cell.name).filter(entry => matches(entry, cell));
    let priority = 1;
    for (const entry of occupied) priority = Math.max(priority, (entry.options.priority ?? 0) + 1);
    const dispose = slots.register({ name: cell.name, ...(cell.key ? { key: cell.key } : {}), ...(cell.id ? { id: cell.id } : {}), priority }, () => null);
    dispose();
  };
  const detach = (binding: Binding) => {
    binding.active = false;
    if (binding.entry.component === binding.wrapper) {
      binding.entry.component = binding.original;
      if (slots.entries(binding.cell.name).includes(binding.entry)) refresh(binding.cell);
    }
    bindings.delete(binding.entry);
  };
  const wrap = (entry: SlotEntry, cell: Cell): Binding => {
    const descriptor = Object.getOwnPropertyDescriptor(entry, 'component');
    if (!descriptor?.writable || !componentLike(entry.component)) throw new Error(`Unsupported component registration: ${label(cell)}`);
    const binding: Binding = { entry, original: entry.component, wrapper: () => null, active: true, cell };
    const Content = (props: Props): ReactNode => {
      try {
        const projected = cell.kind === 'message' ? messageProps(props) : pendingProps(props);
        return projected === null ? null : createElement(binding.original, projected);
      } catch (error) { failure(error); return createElement('div', { role: 'alert' }, 'Recall display unavailable. Reload the page.'); }
    };
    const Composer = (props: Props): ReactNode => {
      const language = useSyncExternalStore(callback => locale.subscribe(callback), () => locale.getLocale().active);
      const t = useCallback((key: string, ...args: unknown[]) => key === 'hint.recall'
        ? RECALL_INPUT_HINT[language.toLowerCase().split('-')[0] === 'zh' ? 'zh' : 'en'] : props.t(key, ...args), [props.t, language]);
      return createElement(binding.original, { ...props, t });
    };
    const View = (props: Props): ReactNode => {
      const previews = props.useProjection(RECALL_PREVIEWS);
      const projection = useMemo(() => viewProjection(previews), [previews]);
      const useChat = useCallback((selector: (snapshot: any) => unknown, ...args: unknown[]) =>
        props.useChat((snapshot: Props) => selector(projection.snapshot(snapshot)), ...args), [props.useChat, projection]);
      const useProjection = useCallback((key: string, ...args: unknown[]) => {
        const value = props.useProjection(key, ...args);
        return key === 'turnOutline' ? projection.items(value) : value;
      }, [props.useProjection, projection]);
      return createElement(binding.original, { ...props, useChat, useProjection });
    };
    const Component = cell.kind === 'composer' ? Composer : cell.kind === 'view' ? View : Content;
    binding.wrapper = (props: Props) => createElement(binding.active ? Component : binding.original, props);
    entry.component = binding.wrapper;
    return binding;
  };
  const reconcile = () => {
    if (stopped || reconciling) return;
    reconciling = true;
    try {
      const current = cells.map(cell => ({ cell, entry: slots.entriesOfSlot(cell.name).find(entry => matches(entry, cell)) }));
      for (const binding of [...bindings.values()]) {
        if (!current.some(item => item.entry === binding.entry)) detach(binding);
        else if (binding.entry.component !== binding.wrapper) {
          // Never fight another plugin's replacement or wrap a wrapper that may
          // already capture ours. Make stale wrappers inert and report the conflict.
          overridden.add(binding.entry); detach(binding);
        }
      }
      const missing: string[] = [];
      for (const { cell, entry } of current) {
        if (!entry || overridden.has(entry)) { missing.push(label(cell)); continue; }
        if (!bindings.has(entry)) { bindings.set(entry, wrap(entry, cell)); refresh(cell); }
      }
      publish({ ready: missing.length === 0, missing });
    } catch (error) { failure(error); }
    finally { reconciling = false; }
  };
  installation.stop = () => {
    if (stopped) return;
    stopped = true;
    for (const dispose of off) dispose();
    for (const binding of [...bindings.values()]) detach(binding);
    installations.delete(slots);
  };
  try {
    for (const name of new Set(cells.map(cell => cell.name))) off.push(slots.subscribe(name, reconcile));
    report(installation.status); reconcile();
  } catch (error) { installation.stop(); throw error; }
  let disposed = false;
  return () => { if (disposed) return; disposed = true; installation.listeners.delete(report); if (--installation.refs === 0) installation.stop(); };
}
