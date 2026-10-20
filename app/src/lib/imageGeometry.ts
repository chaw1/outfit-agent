/** All points sent to the API are relative to the original image, never its letterbox. */
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface ImageRect extends Point, Size {}
export interface ImageTransform { scale: number; translateX: number; translateY: number }
export interface NormalizedRegion { x: number; y: number; w: number; h: number }

export const IDENTITY_TRANSFORM: ImageTransform = { scale: 1, translateX: 0, translateY: 0 };
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function positiveSize(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

/** The exact rectangle produced by resizeMode="contain" / contentFit="contain". */
export function containRect(image: Size, viewport: Size): ImageRect | null {
  if (!positiveSize(image) || !positiveSize(viewport)) return null;
  const fit = Math.min(viewport.width / image.width, viewport.height / image.height);
  const width = image.width * fit;
  const height = image.height * fit;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}

/** React Native transforms are centered on the viewport: scale, then translation. */
export function imageToScreen(point: Point, rect: ImageRect, viewport: Size, transform: ImageTransform): Point {
  return {
    x: viewport.width / 2 + (rect.x + point.x * rect.width - viewport.width / 2) * transform.scale + transform.translateX,
    y: viewport.height / 2 + (rect.y + point.y * rect.height - viewport.height / 2) * transform.scale + transform.translateY,
  };
}

/** Invert both the contain fit and the viewport-centered transform. Ignore starts in blank space. */
export function screenToImage(point: Point, rect: ImageRect, viewport: Size, transform: ImageTransform, clampToEdge = false): Point | null {
  if (!positiveSize(rect) || !positiveSize(viewport) || !Number.isFinite(transform.scale) || transform.scale <= 0 ||
      ![point.x, point.y, transform.translateX, transform.translateY].every(Number.isFinite)) return null;
  const x = ((point.x - viewport.width / 2 - transform.translateX) / transform.scale + viewport.width / 2 - rect.x) / rect.width;
  const y = ((point.y - viewport.height / 2 - transform.translateY) / transform.scale + viewport.height / 2 - rect.y) / rect.height;
  const epsilon = 1e-9;
  if (!clampToEdge && (x < -epsilon || x > 1 + epsilon || y < -epsilon || y > 1 + epsilon)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

export function regionFromPoints(start: Point, end: Point): NormalizedRegion {
  const x1 = clamp(start.x, 0, 1), x2 = clamp(end.x, 0, 1);
  const y1 = clamp(start.y, 0, 1), y2 = clamp(end.y, 0, 1);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Brush is normalized against the original short edge, not the viewport or zoom. */
export function screenBrushToNormalized(screenWidth: number, rect: ImageRect, scale: number): number {
  if (!positiveSize(rect) || !Number.isFinite(scale) || scale <= 0 || !Number.isFinite(screenWidth)) return 0;
  return clamp(screenWidth / (Math.min(rect.width, rect.height) * scale), 0, 1);
}

export function constrainTransform(transform: ImageTransform, rect: ImageRect, viewport: Size): ImageTransform {
  const scale = clamp(Number.isFinite(transform.scale) ? transform.scale : 1, 1, 5);
  const maxX = Math.max(0, (rect.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (rect.height * scale - viewport.height) / 2);
  return {
    scale,
    translateX: clamp(Number.isFinite(transform.translateX) ? transform.translateX : 0, -maxX, maxX),
    translateY: clamp(Number.isFinite(transform.translateY) ? transform.translateY : 0, -maxY, maxY),
  };
}

/** Keep the image point under a pinch focal point stationary, except at pan limits. */
export function zoomAtPoint(transform: ImageTransform, nextScale: number, focal: Point, viewport: Size, rect: ImageRect): ImageTransform {
  const scale = clamp(nextScale, 1, 5);
  const ratio = scale / transform.scale;
  return constrainTransform({
    scale,
    translateX: focal.x - viewport.width / 2 - (focal.x - viewport.width / 2 - transform.translateX) * ratio,
    translateY: focal.y - viewport.height / 2 - (focal.y - viewport.height / 2 - transform.translateY) * ratio,
  }, rect, viewport);
}

interface VersionedImage { id: string; parent_id?: string; version: number }

/** Follow parent links, including branches; a matching shot_id alone never implies a version. */
export function imageVersionFamily<T extends VersionedImage>(images: readonly T[], currentId: string): T[] {
  const map = new Map(images.map(image => [image.id, image]));
  let root = map.get(currentId);
  if (!root) return [];
  const ancestors = new Set<string>();
  while (root.parent_id && map.has(root.parent_id) && !ancestors.has(root.parent_id)) {
    ancestors.add(root.id);
    root = map.get(root.parent_id)!;
  }
  const result: T[] = [];
  const visited = new Set<string>();
  const visit = (image: T) => {
    if (visited.has(image.id)) return;
    visited.add(image.id);
    result.push(image);
    images.filter(child => child.parent_id === image.id).sort((a, b) => a.version - b.version || a.id.localeCompare(b.id)).forEach(visit);
  };
  visit(root);
  return result.sort((a, b) => a.version - b.version || a.id.localeCompare(b.id));
}

/** Duplicate instructions can target different masks: pair submitted actions with result order. */
export function editActionForResult<T extends { image_id: string; instruction: string }>(
  images: readonly (VersionedImage & { instruction?: string })[],
  actions: readonly T[],
  resultId: string,
): T | undefined {
  const result = images.find(image => image.id === resultId);
  if (!result?.parent_id || !result.instruction) return undefined;
  const siblings = images.filter(image => image.parent_id === result.parent_id && image.instruction === result.instruction).sort((a, b) => a.version - b.version || a.id.localeCompare(b.id));
  const matchingActions = actions.filter(action => action.image_id === result.parent_id && action.instruction === result.instruction);
  return matchingActions[siblings.findIndex(image => image.id === result.id)];
}
