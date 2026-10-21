import { createGenerationRuntime } from './completionTracker';
import { setRecentCompletions } from './completionFeed';
export type { NotificationSession, CompletionListener } from './completionTracker';

// Web receives the same deduplicated in-app notices without native OS APIs.
const runtime = createGenerationRuntime({
  onCompletions: setRecentCompletions,
  deliver: async (completion, _owner, isCurrent, listener) => { if (isCurrent()) listener?.(completion); },
});
export const configureNotifications = runtime.configure;
export function observeGeneration(...args: Parameters<typeof runtime.observe>): void { void runtime.observe(...args).catch(() => undefined); }
export const pollGenerations = runtime.poll;
export function markGenerationRead(id: string, jobIds: readonly string[], scope: string): void {
  if (runtime.currentOwner() !== scope) return;
  void runtime.markRead(id, jobIds).catch(() => undefined);
}
export function listenNotificationTap(_callback: (id: string) => void): () => void { return () => undefined; }
