import type { Message, ProjectState } from './types';

/** Track persisted history separately from state, including messages discovered during SSE. */
export class WorkspaceHistorySync {
  private lastMessageId: string | null = null;
  private loadedIds = new Set<string>();

  observeState(state: Pick<ProjectState, 'last_message_id'>): void {
    // Older services do not provide the marker; explicit refreshes still fetch history.
    if (state.last_message_id !== undefined) this.lastMessageId = state.last_message_id;
  }

  needsHistory(streaming: boolean, force = false): boolean {
    return !streaming && (force || Boolean(this.lastMessageId && !this.loadedIds.has(this.lastMessageId)));
  }

  canApplyHistory(messages: readonly Message[]): boolean {
    // A state response may arrive before its message becomes visible to the messages endpoint.
    return !this.lastMessageId || messages.some(message => message.id === this.lastMessageId);
  }

  appliedHistory(messages: readonly Message[]): void {
    this.loadedIds = new Set(messages.map(message => message.id));
  }
}
