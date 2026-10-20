import type { Project, User, UserProfile } from '../api/types';

export interface ProfilePhoto { id: string; url?: string }

export function supportsProfile(user: User | null): user is User & { profile: UserProfile } {
  return !!user?.profile && Array.isArray(user.profile.model_asset_ids);
}

export function profileCacheKey(baseUrl: string, userId: string): string {
  return `outfit.photos:${JSON.stringify([baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/, ''), userId])}`;
}

export function profilePhotos(ids: readonly string[], cached: readonly ProfilePhoto[]): ProfilePhoto[] {
  const byId = new Map(cached.map(photo => [photo.id, photo]));
  return [...new Set(ids)].map(id => byId.get(id) ?? { id });
}

export function setDefaultPhoto(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [id, ...ids.filter(item => item !== id)] : [...ids];
}

export function parseHeight(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const height = Number(value);
  if (!Number.isFinite(height) || height < 80 || height > 250) throw new Error('身高请填写 80–250 之间的厘米数。');
  return height;
}

export function filterProjects(items: readonly Project[], query: string): Project[] {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => !search || `${item.title}\n${item.brand}`.toLocaleLowerCase().includes(search));
}

export function parsePhotoCache(raw: string | null): ProfilePhoto[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((photo): photo is ProfilePhoto => !!photo && typeof photo === 'object'
      && typeof photo.id === 'string' && typeof photo.url === 'string');
  } catch { return []; }
}
