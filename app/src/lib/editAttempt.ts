import type { Action } from '../api/types';

type EditAction = Extract<Action, { type: 'edit_image' }>;
export interface ActionResult { accepted: boolean; reused?: boolean }
export interface EditSubmission { key: string; action: EditAction }

/** UUID v4 works in Expo runtimes as well as browsers without requiring a native module. */
export function newEditAttempt(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

/** Network replay keeps the input object and attempt; explicit retries request a fresh attempt. */
export function editWithAttempt(action: EditAction, fresh = false): EditAction {
  return action.attempt && !fresh ? action : { ...action, attempt: newEditAttempt() };
}

export function prepareEditSubmission(action: EditAction, previous?: EditSubmission, fresh = false): EditSubmission {
  const key = JSON.stringify({ ...action, attempt: undefined });
  return { key, action: !fresh && previous?.key === key ? previous.action : editWithAttempt(action, fresh) };
}

export function reusedResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'reused' in result && result.reused === true;
}

export function rejectedResult(result: unknown): boolean {
  return result === false || (typeof result === 'object' && result !== null && 'accepted' in result && result.accepted === false);
}
