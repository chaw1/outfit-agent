import type { Action, NoteData, OutfitImage } from '../api/types';

export const isUnverified = (image: OutfitImage) => image.edit_check?.passed === false;
export const hasConsistentPerson = (image: OutfitImage) => image.fidelity?.person_score === undefined || image.fidelity.person_score >= 70;
export const isUsable = (image: OutfitImage) => image.status === 'succeeded' && Boolean(image.url);

/** Keep shot order stable while choosing the newest usable, verified version. */
export function defaultImageIds(images: readonly OutfitImage[], note?: NoteData): string[] {
  if (note) return note.image_ids.filter(id => images.some(image => image.id === id && isUsable(image)));
  const latest = new Map<string, OutfitImage>();
  for (const image of images) {
    if (!latest.has(image.shot_id)) latest.set(image.shot_id, image);
  }
  for (const shot of latest.keys()) {
    const candidates = images.filter(image => image.shot_id === shot && isUsable(image) && !isUnverified(image) && hasConsistentPerson(image));
    const selected = candidates.reduce<OutfitImage | undefined>((best, image) => !best || image.version > best.version ? image : best, undefined);
    if (selected) latest.set(shot, selected);
    else latest.delete(shot);
  }
  return [...latest.values()].map(image => image.id);
}

/** Adopting a version replaces the same shot in place, retaining the cover and order. */
export function replaceShotVersion(ids: readonly string[], replacement: OutfitImage, images: readonly OutfitImage[]): string[] {
  const sameShot = new Set(images.filter(image => image.shot_id === replacement.shot_id).map(image => image.id));
  const index = ids.findIndex(id => sameShot.has(id));
  if (index < 0) return [...ids, replacement.id];
  const result = ids.filter(id => !sameShot.has(id));
  result.splice(index, 0, replacement.id);
  return result;
}

export function approveImages(ids: readonly string[], images: readonly OutfitImage[], accepted: readonly string[]): Extract<Action, { type: 'approve_images' }> {
  const accept_unverified = ids.filter(id => accepted.includes(id) && images.some(image => image.id === id && isUnverified(image)));
  return { type: 'approve_images', image_ids: [...ids], ...(accept_unverified.length ? { accept_unverified } : {}) };
}
