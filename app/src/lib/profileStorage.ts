import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { parsePhotoCache, type ProfilePhoto } from './profile';

function filename(key: string): string {
  let hash = 2166136261;
  for (const letter of key) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619);
  return `profile-${(hash >>> 0).toString(16)}`;
}

export async function readPhotoCache(key: string): Promise<ProfilePhoto[]> {
  try {
    if (Platform.OS === 'web') return parsePhotoCache(localStorage.getItem(key));
    const file = new File(Paths.document, `${filename(key)}.json`);
    if (!file.exists) return [];
    const saved = JSON.parse(await file.text()) as { key?: string; photos?: unknown };
    return saved.key === key ? parsePhotoCache(JSON.stringify(saved.photos)) : [];
  } catch { return []; }
}

export async function writePhotoCache(key: string, photos: ProfilePhoto[]): Promise<void> {
  if (Platform.OS === 'web') localStorage.setItem(key, JSON.stringify(photos));
  else {
    const file = new File(Paths.document, `${filename(key)}.json`);
    if (!file.exists) file.create();
    await file.write(JSON.stringify({ key, photos }));
  }
}

/** Keep a local preview: the server contract exposes IDs and signed upload URLs expire. */
export async function persistPhotoPreview(key: string, id: string, uri: string): Promise<string> {
  if (Platform.OS !== 'web') {
    const extension = uri.split('?')[0].split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'jpg';
    const target = new File(Paths.document, `${filename(key)}-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${extension}`);
    await new File(uri).copy(target, { overwrite: true });
    return target.uri;
  }
  const image = new Image();
  image.src = uri;
  await image.decode();
  const scale = Math.min(1, 360 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('照片预览暂时不可用。');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}
