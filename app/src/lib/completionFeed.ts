import type { Completion } from './completionTracker';

const empty: readonly Completion[] = [];
const values = new Map<string, readonly Completion[]>();
const listeners = new Map<string, Set<() => void>>();

/** A small, account-scoped view of the existing completion notifications. */
export function recentCompletions(scope: string): readonly Completion[] { return values.get(scope) ?? empty; }
export function setRecentCompletions(scope: string, incoming: readonly Completion[]): void {
  const previous = recentCompletions(scope);
  const next = incoming.slice(0, 5);
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  values.set(scope, next.length ? next : empty);
  listeners.get(scope)?.forEach(listener => listener());
}
export function publishCompletion(scope: string, completion: Completion): void {
  setRecentCompletions(scope, [completion, ...recentCompletions(scope).filter(value => value.projectId !== completion.projectId)]);
}
export function subscribeCompletions(scope: string, listener: () => void): () => void {
  const subscribers = listeners.get(scope) ?? new Set<() => void>();
  subscribers.add(listener); listeners.set(scope, subscribers);
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(scope); };
}
