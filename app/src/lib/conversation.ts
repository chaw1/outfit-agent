import type { Message, ProjectState, SendMessageInput } from '../api/types';

/** Eligibility is a server assertion; legacy histories must never guess at cost safety. */
export function canRephrase(message: Message, messages: readonly Message[], state?: ProjectState): boolean {
  return message.role === 'assistant' && message.can_regenerate === true && message.id === messages.at(-1)?.id && !state?.active_jobs.length;
}
export interface FailedMessage { id: string; input: SendMessageInput; text: string; createdAt: string; certain: boolean; baseline: string[] }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function persistedRetry(failed: FailedMessage, history: readonly Message[]): boolean {
  return history.some(message => message.role === 'user' && !failed.baseline.includes(message.id)
    && (failed.input.action ? canonical(message.action) === canonical(failed.input.action) : message.text === failed.input.text)
    && canonical(message.refs ?? []) === canonical(failed.input.refs ?? []));
}
