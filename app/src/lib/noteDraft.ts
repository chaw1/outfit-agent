import type { NoteData } from '../api/types';

export const NOTE_TITLE_LIMIT = 20;

export interface NoteDraft {
  title: string;
  body: string;
  tags: string[];
  image_ids: string[];
  aiConfirmed: boolean;
}

export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function titleLength(title: string): number { return Array.from(title).length; }
export function limitTitle(title: string): string { return Array.from(title).slice(0, NOTE_TITLE_LIMIT).join(''); }
export function cleanTag(tag: string): string { return tag.trim().replace(/^#+/, '').replace(/\s+/g, ''); }

export function draftFromNote(note: NoteData): NoteDraft {
  return { title: note.title, body: note.body, tags: [...new Set(note.tags.map(cleanTag).filter(Boolean))], image_ids: [...note.image_ids], aiConfirmed: true };
}

/** Keep server metadata while locally overriding the editable publishing fields. */
export function applyNoteDraft(note: NoteData, draft: NoteDraft | null): NoteData {
  return draft ? { ...note, title: draft.title, body: draft.body, tags: [...draft.tags], image_ids: [...draft.image_ids] } : note;
}

export function moveDraftImage(ids: readonly string[], index: number, offset: -1 | 1): string[] {
  const next = [...ids];
  const target = index + offset;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function draftStorageKey(scope: string): string {
  let hash = 2166136261;
  for (const character of scope) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `outfit-note-draft-${(hash >>> 0).toString(16)}`;
}

function isDraft(value: unknown): value is NoteDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.title === 'string' && typeof draft.body === 'string' && typeof draft.aiConfirmed === 'boolean'
    && Array.isArray(draft.tags) && draft.tags.every(tag => typeof tag === 'string')
    && Array.isArray(draft.image_ids) && draft.image_ids.every(id => typeof id === 'string')
    && new Set(draft.image_ids).size === draft.image_ids.length;
}

export function readNoteDraft(scope: string, storage: DraftStorage): NoteDraft | null {
  try {
    const raw = storage.getItem(draftStorageKey(scope));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || saved.scope !== scope || !isDraft(saved.draft)) return null;
    return { ...saved.draft, tags: [...saved.draft.tags], image_ids: [...saved.draft.image_ids] };
  } catch { return null; }
}

/** A false result must be shown to the user; an in-memory copy is not a saved draft. */
export function writeNoteDraft(scope: string, draft: NoteDraft, storage: DraftStorage): boolean {
  try {
    storage.setItem(draftStorageKey(scope), JSON.stringify({ version: 1, scope, draft }));
    return true;
  } catch { return false; }
}
