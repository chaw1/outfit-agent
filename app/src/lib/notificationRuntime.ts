import { createGenerationRuntime } from './completionTracker';
export type { NotificationSession, CompletionListener } from './completionTracker';

// Web receives the same deduplicated in-app notices without native OS APIs.
const runtime = createGenerationRuntime({ deliver: async (completion, _owner, isCurrent, listener) => { if (isCurrent()) listener?.(completion); } });
export const configureNotifications = runtime.configure;
export function observeGeneration(...args: Parameters<typeof runtime.observe>): void { void runtime.observe(...args).catch(() => undefined); }
export const pollGenerations = runtime.poll;
export function listenNotificationTap(_callback: (id: string) => void): () => void { return () => undefined; }
