import type { Action, Direction, JobStatus } from '../api/types';
import { newEditAttempt } from './editAttempt';

export interface DirectionPreview {
  id: string;
  url?: string | null;
  status: JobStatus;
  variant: string;
}

/** Older services still expose the first image through the original fields. */
export function directionPreviews(direction: Direction): DirectionPreview[] {
  if (direction.previews?.length) return direction.previews;
  return [{ id: `legacy:${direction.id}`, url: direction.preview_url, status: direction.preview_status ?? 'queued', variant: '灵感预览' }];
}

export function selectedPreview(direction: Direction, pickedId?: string): DirectionPreview {
  const previews = directionPreviews(direction);
  return previews.find(item => item.id === pickedId) ?? previews[0];
}

export function chooseDirectionPreview(direction: Direction, pickedId?: string): Extract<Action, { type: 'choose_direction' }> {
  const preview = selectedPreview(direction, pickedId);
  return { type: 'choose_direction', direction_id: direction.id, ...(direction.previews?.some(item => item.id === preview.id) ? { preview_id: preview.id } : {}) };
}

/** The same action can be replayed; a new explicit retry gets a new attempt. */
export function retryDirectionPreview(direction: Direction, previewId: string, attempt = newEditAttempt()): Extract<Action, { type: 'retry_preview' }> | undefined {
  const preview = direction.previews?.find(item => item.id === previewId);
  if (preview?.status !== 'failed') return undefined;
  return { type: 'retry_preview', direction_id: direction.id, preview_id: preview.id, attempt };
}
