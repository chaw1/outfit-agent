import type { OutfitImage, ScriptData } from '../api/types';
import { isUnverified, isUsable } from './imageSelection';

/** Older projects can identify their cover through the generated anchor reference. */
export function coverShotId(images: readonly OutfitImage[], script?: ScriptData): string | undefined {
  if (script?.shots[0]) return script.shots[0].id;
  const anchors = new Set(images.flatMap(image => image.anchor_id ? [image.anchor_id] : []));
  return images.find(image => anchors.has(image.id))?.shot_id;
}

export function isCoverImage(image: OutfitImage | undefined, images: readonly OutfitImage[], script?: ScriptData, adoptedIds?: readonly string[]): boolean {
  const shot = coverShotId(images, script);
  if (!image || !shot || image.shot_id !== shot || !isUsable(image)) return false;
  const adopted = images.find(item => item.shot_id === shot && isUsable(item) && adoptedIds?.includes(item.id));
  const latest = adopted ?? images.filter(item => item.shot_id === shot && isUsable(item) && !isUnverified(item))
    .reduce<OutfitImage | undefined>((best, item) => !best || item.version > best.version ? item : best, undefined);
  return latest?.id === image.id;
}

/** Keep the chosen cover version first; selecting a newer version keeps the same slot. */
export function coverFirstImageIds(ids: readonly string[], images: readonly OutfitImage[], script?: ScriptData): string[] {
  if (!ids.length) return [];
  const shot = coverShotId(images, script);
  const cover = images.find(image => isCoverImage(image, images, script, ids));
  if (!cover) return [...ids];
  return [cover.id, ...ids.filter(id => id !== cover.id && !images.some(image => image.id === id && image.shot_id === shot))];
}
