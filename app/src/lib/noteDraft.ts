import type { NoteData } from '../api/types';
import { sha256 } from './sha256';

export const NOTE_TITLE_LIMIT = 20;

export interface NoteDraft {
  title: string;
  body: string;
  tags: string[];
  image_ids: string[];
  accepted_unverified_ids?: string[];
  aiConfirmed: boolean;
  sourceFingerprint: string;
  dirty: boolean;
}

export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function titleLength(title: string): number { return Array.from(title).length; }
export function limitTitle(title: string): string { return Array.from(title).slice(0, NOTE_TITLE_LIMIT).join(''); }
export function cleanTag(tag: string): string { return tag.trim().replace(/^#+/, '').replace(/\s+/g, ''); }

/** Field boundaries and array order are part of the source, so distinct notes cannot alias. */
export function noteSourceFingerprint(note: Pick<NoteData, 'title' | 'body' | 'tags' | 'image_ids'>): string {
  return sha256(JSON.stringify([note.title, note.body, note.tags, note.image_ids]));
}

export function draftFromNote(note: NoteData): NoteDraft {
  return {
    title: note.title, body: note.body, tags: [...new Set(note.tags.map(cleanTag).filter(Boolean))], image_ids: [...note.image_ids],
    ...(note.accepted_unverified_ids ? { accepted_unverified_ids: [...new Set(note.accepted_unverified_ids.filter(id => note.image_ids.includes(id)))] } : {}),
    aiConfirmed: true, sourceFingerprint: noteSourceFingerprint(note), dirty: false,
  };
}

export function hasNoteDraftConflict(note: NoteData, draft: NoteDraft | null): boolean {
  return Boolean(draft?.dirty && draft.sourceFingerprint !== noteSourceFingerprint(note));
}

/** A server refresh follows clean drafts and leaves authored work intact until a decision. */
export function reconcileNoteDraft(note: NoteData, draft: NoteDraft | null): NoteDraft {
  return !draft?.dirty ? draftFromNote(note) : draft;
}

export function changeNoteDraft(draft: NoteDraft, changes: Partial<Pick<NoteDraft, 'title' | 'body' | 'tags' | 'image_ids' | 'aiConfirmed'>>): NoteDraft {
  const changed = Object.entries(changes).some(([key, value]) => JSON.stringify(draft[key as keyof NoteDraft]) !== JSON.stringify(value));
  return { ...draft, ...changes, dirty: draft.dirty || changed };
}

/** Keeping local edits acknowledges this source revision, while preserving every local field. */
export function keepNoteDraft(note: NoteData, draft: NoteDraft): NoteDraft {
  return { ...draft, sourceFingerprint: noteSourceFingerprint(note), dirty: true };
}

/** Keep server metadata while locally overriding the editable publishing fields. */
export function applyNoteDraft(note: NoteData, draft: NoteDraft | null): NoteData {
  if (!draft) return note;
  const accepted = draft.accepted_unverified_ids ?? note.accepted_unverified_ids;
  return {
    ...note, title: draft.title, body: draft.body, tags: [...draft.tags], image_ids: [...draft.image_ids],
    ...(accepted ? { accepted_unverified_ids: accepted.filter(id => draft.image_ids.includes(id)) } : {}),
  };
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

function isDraft(value: unknown): value is Omit<NoteDraft, 'sourceFingerprint' | 'dirty'> & Partial<Pick<NoteDraft, 'sourceFingerprint' | 'dirty'>> {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.title === 'string' && typeof draft.body === 'string' && typeof draft.aiConfirmed === 'boolean'
    && Array.isArray(draft.tags) && draft.tags.every(tag => typeof tag === 'string')
    && Array.isArray(draft.image_ids) && draft.image_ids.every(id => typeof id === 'string')
    && new Set(draft.image_ids).size === draft.image_ids.length
    && (draft.accepted_unverified_ids === undefined || Array.isArray(draft.accepted_unverified_ids) && draft.accepted_unverified_ids.every(id => typeof id === 'string') && new Set(draft.accepted_unverified_ids).size === draft.accepted_unverified_ids.length)
    && (draft.sourceFingerprint === undefined || typeof draft.sourceFingerprint === 'string' && (draft.sourceFingerprint === '' || /^[a-f0-9]{64}$/.test(draft.sourceFingerprint)))
    && (draft.dirty === undefined || typeof draft.dirty === 'boolean');
}

export function readNoteDraft(scope: string, storage: DraftStorage): NoteDraft | null {
  try {
    const raw = storage.getItem(draftStorageKey(scope));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (![1, 2].includes(saved.version) || saved.scope !== scope || !isDraft(saved.draft)) return null;
    if (saved.version === 2 && (typeof saved.draft.sourceFingerprint !== 'string' || typeof saved.draft.dirty !== 'boolean')) return null;
    // Older saved drafts contain authored work without a recorded source. Ask before replacing it.
    return { ...saved.draft, tags: [...saved.draft.tags], image_ids: [...saved.draft.image_ids], ...(saved.draft.accepted_unverified_ids ? { accepted_unverified_ids: [...saved.draft.accepted_unverified_ids] } : {}), sourceFingerprint: saved.draft.sourceFingerprint ?? '', dirty: saved.draft.dirty ?? true };
  } catch { return null; }
}

/** A false result must be shown to the user; an in-memory copy is not a saved draft. */
export function writeNoteDraft(scope: string, draft: NoteDraft, storage: DraftStorage): boolean {
  try {
    storage.setItem(draftStorageKey(scope), JSON.stringify({ version: 2, scope, draft }));
    return true;
  } catch { return false; }
}

export function readPreviousNoteDraft(scope: string, storage: DraftStorage): NoteDraft | null {
  return readNoteDraft(`${scope}|previous-note-draft`, storage);
}

/** An explicit switch keeps the authored draft recoverable on this device. */
export function writePreviousNoteDraft(scope: string, draft: NoteDraft, storage: DraftStorage): boolean {
  return writeNoteDraft(`${scope}|previous-note-draft`, draft, storage);
}
