import { File, FileMode, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Platform, Share } from 'react-native';
import { mediaExtension, mediaFilename } from './mediaFormats';
import type { ShareOutcome } from './publish';

export interface SavableImage { id: string; url: string }
export interface SaveImageFailure { id: string; message: string }
export interface SaveImagesResult { savedIds: string[]; failed: SaveImageFailure[]; skipped: number }

type MediaKind = 'image' | 'video';

async function downloadInBrowser(media: SavableImage, kind: MediaKind): Promise<void> {
  const response = await fetch(media.url);
  if (!response.ok) throw new Error(`${kind === 'image' ? '图片' : '视频'}下载失败（${response.status}）`);
  const blob = await response.blob();
  const extension = mediaExtension(new Uint8Array(await blob.slice(0, 32).arrayBuffer()), kind);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = mediaFilename(media.id, extension);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function saveToPhotos(media: SavableImage, kind: MediaKind): Promise<void> {
  const destination = new File(Paths.cache, mediaFilename(media.id, 'download'));
  let downloaded: File | undefined;
  try {
    downloaded = await File.downloadFileAsync(media.url, destination, { idempotent: true });
    const handle = downloaded.open(FileMode.ReadOnly);
    let extension: string;
    try { extension = mediaExtension(await handle.readBytes(32), kind); }
    finally { handle.close(); }
    await downloaded.move(new File(Paths.cache, mediaFilename(media.id, extension)), { overwrite: true });
    await MediaLibrary.Asset.create(downloaded.uri);
  } finally {
    try {
      if (downloaded?.exists) downloaded.delete();
      if (destination.exists) destination.delete();
    }
    catch { /* 缓存清理失败不影响已保存到相册的媒体。 */ }
  }
}

async function requestSavePermission(kind: MediaKind): Promise<void> {
  if (Platform.OS === 'web') return;
  const permission = await MediaLibrary.requestPermissionsAsync(true, [kind === 'image' ? 'photo' : 'video']);
  if (!permission.granted) throw new Error(`需要允许保存到照片，才能把${kind === 'image' ? '图片' : '视频'}放进相册。请在系统设置中开启照片权限后重试。`);
}

/** Retry only unfinished images and stop at the first failure to preserve album order. */
export async function saveImages(
  images: readonly SavableImage[],
  alreadySaved: ReadonlySet<string> = new Set(),
  onProgress?: (finished: number, total: number) => void,
): Promise<SaveImagesResult> {
  const unique = [...new Map(images.map((image) => [image.id, image])).values()];
  const pending = unique.filter((image) => !alreadySaved.has(image.id));
  const result: SaveImagesResult = { savedIds: [], failed: [], skipped: unique.length - pending.length };
  if (!pending.length) return result;
  await requestSavePermission('image');
  onProgress?.(0, pending.length);
  for (const [index, image] of pending.entries()) {
    try {
      if (Platform.OS === 'web') await downloadInBrowser(image, 'image');
      else await saveToPhotos(image, 'image');
      result.savedIds.push(image.id);
    } catch (error) {
      result.failed.push({ id: image.id, message: error instanceof Error ? error.message : '图片保存失败，请重试。' });
      break;
    }
    onProgress?.(index + 1, pending.length);
  }
  return result;
}

export async function saveVideo(video: SavableImage): Promise<void> {
  await requestSavePermission('video');
  if (Platform.OS === 'web') await downloadInBrowser(video, 'video');
  else await saveToPhotos(video, 'video');
}

export async function shareNote(title: string, text: string): Promise<ShareOutcome> {
  if (Platform.OS === 'web' && typeof navigator.share !== 'function') return 'unavailable';
  try {
    const result = await Share.share({ title, message: text }, { dialogTitle: '发布穿搭笔记', subject: title });
    return result?.action === Share.dismissedAction ? 'dismissed' : 'shared';
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') return 'dismissed';
    throw new Error('系统分享暂时不可用。文案和已保存的媒体仍在，可手动打开发布平台，或重试打开分享面板。');
  }
}
