import { File, FileMode, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

export interface SavableImage { id: string; url: string }
export interface SaveImageFailure { id: string; message: string }
export interface SaveImagesResult { savedIds: string[]; failed: SaveImageFailure[]; skipped: number }

function imageFilename(id: string, extension: string): string {
  return `outfit-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${extension}`;
}

function imageExtension(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['avif', 'avis'].includes(brand)) return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'tif';
  throw new Error('下载的文件不是可保存的图片，请刷新笔记后重试。');
}

async function downloadInBrowser(image: SavableImage): Promise<void> {
  const response = await fetch(image.url);
  if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
  const blob = await response.blob();
  const extension = imageExtension(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = imageFilename(image.id, extension);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function saveToPhotos(image: SavableImage): Promise<void> {
  const destination = new File(Paths.cache, imageFilename(image.id, 'download'));
  let downloaded: File | undefined;
  try {
    downloaded = await File.downloadFileAsync(image.url, destination, { idempotent: true });
    const handle = downloaded.open(FileMode.ReadOnly);
    let extension: string;
    try { extension = imageExtension(await handle.readBytes(32)); }
    finally { handle.close(); }
    await downloaded.move(new File(Paths.cache, imageFilename(image.id, extension)), { overwrite: true });
    await MediaLibrary.Asset.create(downloaded.uri);
  } finally {
    try {
      if (downloaded?.exists) downloaded.delete();
      if (destination.exists) destination.delete();
    }
    catch { /* 缓存清理失败不影响已保存到相册的图片。 */ }
  }
}

/** Retry only unfinished images, so a partial failure never saves successful ones twice. */
export async function saveImages(
  images: readonly SavableImage[],
  alreadySaved: ReadonlySet<string> = new Set(),
  onProgress?: (finished: number, total: number) => void,
): Promise<SaveImagesResult> {
  const unique = [...new Map(images.map((image) => [image.id, image])).values()];
  const pending = unique.filter((image) => !alreadySaved.has(image.id));
  const result: SaveImagesResult = { savedIds: [], failed: [], skipped: unique.length - pending.length };
  if (!pending.length) return result;

  if (Platform.OS !== 'web') {
    const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
    if (!permission.granted) throw new Error('需要允许保存到照片，才能把图片放进相册。请在系统设置中开启照片权限后重试。');
  }

  onProgress?.(0, pending.length);
  for (const [index, image] of pending.entries()) {
    try {
      if (Platform.OS === 'web') await downloadInBrowser(image);
      else await saveToPhotos(image);
      result.savedIds.push(image.id);
    } catch (error) {
      result.failed.push({ id: image.id, message: error instanceof Error ? error.message : '图片保存失败，请重试。' });
    }
    onProgress?.(index + 1, pending.length);
  }
  return result;
}
