import type { Completion } from './completionTracker';

const empty: readonly Completion[] = [];
const values = new Map<string, readonly Completion[]>();
const listeners = new Map<string, Set<() => void>>();

/** A small, account-scoped view of the existing completion notifications. */
export function recentCompletions(scope: string): readonly Completion[] { return values.get(scope) ?? empty; }
export function publishCompletion(scope: string, completion: Completion): void {
  const previous = values.get(scope) ?? empty;
  values.set(scope, [completion, ...previous.filter(value => value.projectId !== completion.projectId)].slice(0, 5));
  listeners.get(scope)?.forEach(listener => listener());
}
export function subscribeCompletions(scope: string, listener: () => void): () => void {
  const subscribers = listeners.get(scope) ?? new Set<() => void>();
  subscribers.add(listener); listeners.set(scope, subscribers);
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(scope); };
}
