import type { JobStatus, NoteData, VideoData } from '../api/types';

export interface PublishImage { id: string; url?: string; status?: JobStatus }
export type ShareOutcome = 'shared' | 'dismissed' | 'unavailable';
export interface PublishProgress {
  copiedText: string | null;
  savedImageIds: string[];
  savedVideoKeys: string[];
  share: ShareOutcome | null;
}
export interface PublishActions {
  copy: (text: string) => Promise<void>;
  saveImage: (image: { id: string; url: string }) => Promise<void>;
  saveVideo: (video: { id: string; url: string }) => Promise<void>;
  share: (title: string, text: string) => Promise<ShareOutcome>;
  changed?: (progress: PublishProgress, step: string) => void;
}

export function emptyPublishProgress(): PublishProgress {
  return { copiedText: null, savedImageIds: [], savedVideoKeys: [], share: null };
}

export function noteText(note: Pick<NoteData, 'title' | 'body' | 'tags'>): string {
  const tags = note.tags.map(tag => `#${tag.replace(/^#/, '')}`).join(' ');
  return [note.title, note.body, tags].filter(Boolean).join('\n\n');
}

/** A job ID survives signed URL renewal; otherwise the URL path identifies this video. */
export function videoKey(video: VideoData): string | undefined {
  if (!video.url) return undefined;
  if (video.job_id) return video.job_id;
  try { const url = new URL(video.url); return `${url.origin}${url.pathname}`; }
  catch { return video.url.split('?')[0]; }
}

export function savedImagesAreInOrder(imageIds: readonly string[], savedIds: readonly string[]): boolean {
  const saved = savedIds.filter(id => imageIds.includes(id));
  return saved.every((id, index) => imageIds[index] === id);
}

/**
 * Checkpoint immediately after each successful side effect. Stop at the first image
 * failure so a retry cannot put an earlier image after later ones in the album.
 */
export async function preparePublish(
  note: NoteData,
  images: readonly PublishImage[],
  video: VideoData | undefined,
  progress: PublishProgress,
  actions: PublishActions,
): Promise<void> {
  if (!note.image_ids.length) throw new Error('这篇笔记还没有图片，请先回工作台选图。');
  if (new Set(note.image_ids).size !== note.image_ids.length) throw new Error('图片清单有重复，请回工作台重新确认图片顺序。');
  const text = noteText(note);
  const changed = (step: string) => actions.changed?.({ ...progress, savedImageIds: [...progress.savedImageIds], savedVideoKeys: [...progress.savedVideoKeys] }, step);
  progress.share = null;
  if (progress.copiedText !== text) {
    changed('正在复制文案');
    await actions.copy(text);
    progress.copiedText = text;
    changed('文案已复制');
  }
  for (const [index, id] of note.image_ids.entries()) {
    if (progress.savedImageIds.includes(id)) continue;
    const image = images.find(item => item.id === id);
    if (!image?.url || (image.status && image.status !== 'succeeded')) throw new Error(`第 ${index + 1} 张图片还没准备好，请刷新笔记后重试。`);
    changed(`正在保存第 ${index + 1}/${note.image_ids.length} 张图片`);
    await actions.saveImage({ id, url: image.url });
    progress.savedImageIds.push(id);
    changed(`第 ${index + 1} 张图片已保存`);
  }
  if (video && ['queued', 'running'].includes(video.status)) throw new Error('图片已保存，视频还在制作中；完成后再点一次即可继续。');
  if (video?.status === 'succeeded') {
    const key = videoKey(video);
    if (!key || !video.url) throw new Error('视频地址还没准备好，请刷新笔记后重试。');
    if (!progress.savedVideoKeys.includes(key)) {
      changed('正在保存视频');
      await actions.saveVideo({ id: `video-${key}`, url: video.url });
      progress.savedVideoKeys.push(key);
      changed('视频已保存');
    }
  }
  changed('正在打开系统分享');
  progress.share = await actions.share(note.title, text);
  changed(progress.share === 'shared' ? '分享面板已打开' : progress.share === 'dismissed' ? '分享已取消，可再次打开' : '当前设备无法打开系统分享');
}
