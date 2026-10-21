import path from 'node:path';
import { expect, type Locator, type Page, type Request } from '@playwright/test';
import type { OutfitImage, ProjectState } from '../src/api/types';

type Point = { x: number; y: number };
type LocalEdit = {
  type: 'edit_image'; image_id: string; instruction: string;
  region?: { x: number; y: number; w: number; h: number };
  mask_strokes?: { brush: number; strokes: Point[][] };
};
type EditMessage = { action: LocalEdit };
type Screenshot = (page: Page, name: string, focus?: Locator) => Promise<void>;

function isEdit(request: Request) {
  return request.method() === 'POST' && request.url().endsWith('/messages') && request.postDataJSON()?.action?.type === 'edit_image';
}

async function drag(page: Page, surface: Locator, points: Point[]) {
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const absolute = points.map(point => ({ x: box!.x + box!.width * point.x, y: box!.y + box!.height * point.y }));
  await page.mouse.move(absolute[0].x, absolute[0].y);
  await page.mouse.down();
  for (const point of absolute.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
}

function expectNormalized(point: Point) {
  expect(point.x).toBeGreaterThanOrEqual(0);
  expect(point.x).toBeLessThanOrEqual(1);
  expect(point.y).toBeGreaterThanOrEqual(0);
  expect(point.y).toBeLessThanOrEqual(1);
}

/** Exercises the real viewer and sends its selections through the ordinary SSE endpoint. */
export async function imageInteractions(page: Page, state: () => ProjectState | undefined, shot: Screenshot) {
  const firstEdit = page.getByTestId(/^edit-image-/).first();
  const firstId = (await firstEdit.getAttribute('data-testid'))!.replace('edit-image-', '');
  const canvas = page.getByTestId('viewer-canvas');
  const close = async () => {
    await page.getByTestId('viewer-close').click();
    await expect(page.getByTestId('image-viewer')).not.toBeVisible();
  };
  const completedChild = async (previousIds: string[], parentId: string) => {
    let result: OutfitImage | undefined;
    await expect.poll(() => {
      result = state()?.images.find(image => !previousIds.includes(image.id) && image.parent_id === parentId && image.status === 'succeeded');
      return result?.id;
    }).toBeTruthy();
    return result!;
  };
  const submit = async () => {
    const request = page.waitForRequest(isEdit);
    await page.getByTestId('submit-edit').click();
    return (await request).postDataJSON() as EditMessage;
  };

  const preview = page.getByTestId(`image-select-${firstId}`);
  await expect(preview.locator('button,[role="button"]')).toHaveCount(0);
  await expect(page.getByTestId(`image-toggle-${firstId}`)).toBeVisible();
  await preview.click();
  await expect(page.getByTestId('image-viewer')).toBeVisible();
  await expect(page.getByText('AI生成', { exact: true })).toHaveCount(0);
  await expect(canvas).toBeVisible();
  await shot(page, '25-image-viewer.png');
  await canvas.dblclick({ position: { x: 160, y: 180 }, delay: 100 });
  await expect(page.getByTestId('viewer-zoom-state')).not.toHaveText('100%');
  await drag(page, canvas, [{ x: 0.5, y: 0.5 }, { x: 0.62, y: 0.56 }]);
  await shot(page, '26-viewer-zoom.png');
  await page.getByTestId('viewer-zoom-reset').click();
  const initialImageTitle = await page.getByTestId('viewer-current-image').textContent();
  await drag(page, canvas, [{ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.5 }]);
  await expect(page.getByTestId('viewer-current-image')).not.toHaveText(initialImageTitle!);
  await expect(page.getByTestId('viewer-zoom-state')).toHaveText('100%');
  await expect(page.getByTestId('viewer-mode-local')).toBeEnabled();
  await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await drag(page, canvas, [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]);
  await expect(page.getByTestId('viewer-current-image')).toHaveText(initialImageTitle!);
  await page.getByTestId('viewer-next').click();
  await page.getByTestId('viewer-previous').click();
  await close();

  // A whole-image change keeps the existing workflow's controls and creates v2.
  await firstEdit.click();
  await page.getByTestId('edit-suggestion-1').click();
  await expect(page.getByTestId('edit-instruction')).toHaveValue('衬衫塞进裤腰');
  await shot(page, '08-edit-image.png');
  let before = state()!.images.map(image => image.id);
  const wholeMessage = await submit();
  expect(wholeMessage.action.image_id).toBe(firstId);
  expect(wholeMessage.action.region).toBeUndefined();
  expect(wholeMessage.action.mask_strokes).toBeUndefined();
  await expect(page.getByTestId('viewer-version-strip')).toContainText(/生成中|排队中/);
  const wholeImage = await completedChild(before, firstId);
  await expect(page.getByTestId(`viewer-version-${wholeImage.id}`)).toBeVisible();
  await expect(page.getByTestId('viewer-compare-slider')).toBeVisible();
  await drag(page, page.getByTestId('viewer-compare-slider'), [{ x: 0.5, y: 0.5 }, { x: 0.74, y: 0.5 }]);
  await shot(page, '27-viewer-version-compare.png');
  await page.getByTestId(`viewer-version-${firstId}`).click();
  await page.getByTestId(`viewer-version-${wholeImage.id}`).click();

  // Draw after zoom/pan, undo one stroke, clear all, then submit a fresh mask.
  await page.getByTestId('viewer-mode-local').click();
  await page.getByTestId('viewer-mode-brush').click();
  await page.getByTestId('viewer-zoom-in').click();
  await expect(page.getByTestId('viewer-zoom-state')).toHaveText('150%');
  await page.getByTestId('viewer-mode-pan').click();
  await drag(page, canvas, [{ x: 0.5, y: 0.5 }, { x: 0.55, y: 0.55 }]);
  await page.getByTestId('viewer-mode-brush').click();
  await drag(page, page.getByTestId('viewer-brush-size'), [{ x: 0.3, y: 0.5 }, { x: 0.6, y: 0.5 }]);
  const stroke = [{ x: 0.4, y: 0.4 }, { x: 0.46, y: 0.46 }, { x: 0.55, y: 0.5 }];
  await drag(page, canvas, stroke);
  await drag(page, canvas, [{ x: 0.6, y: 0.4 }, { x: 0.62, y: 0.5 }]);
  await expect(page.getByTestId('viewer-region-status')).toContainText('2');
  await page.waitForResponse(response => response.url().endsWith('/state') && response.request().method() === 'GET' && response.ok());
  await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId('viewer-zoom-state')).toHaveText('150%');
  await expect(page.getByTestId('viewer-region-status')).toContainText('2');
  await page.getByTestId('viewer-undo').click();
  await expect(page.getByTestId('viewer-region-status')).toContainText('1');
  await page.getByTestId('viewer-clear').click();
  await expect(page.getByTestId('viewer-region-status')).toContainText('0');
  const brushCanvas = (await canvas.boundingBox())!;
  const natural = await canvas.locator('img').first().evaluate(element => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }));
  expect(natural.width).toBeGreaterThan(0);
  expect(natural.height).toBeGreaterThan(0);
  const containScale = Math.min(brushCanvas.width / natural.width, brushCanvas.height / natural.height);
  const panX = Math.min(brushCanvas.width * .05, Math.max(0, (natural.width * containScale * 1.5 - brushCanvas.width) / 2));
  const panY = Math.min(brushCanvas.height * .05, Math.max(0, (natural.height * containScale * 1.5 - brushCanvas.height) / 2));
  const expectedStart = {
    x: .5 + ((stroke[0].x - .5) * brushCanvas.width - panX) / (natural.width * containScale * 1.5),
    y: .5 + ((stroke[0].y - .5) * brushCanvas.height - panY) / (natural.height * containScale * 1.5),
  };
  await drag(page, canvas, stroke);
  await page.getByTestId('edit-instruction').fill('袖口放下来');
  await shot(page, '28-viewer-brush.png');
  before = state()!.images.map(image => image.id);
  const brushMessage = await submit();
  expect(brushMessage.action.image_id).toBe(wholeImage.id);
  expect(brushMessage.action.region).toBeUndefined();
  expect(brushMessage.action.mask_strokes?.strokes).toHaveLength(1);
  expect(brushMessage.action.mask_strokes!.brush).toBeGreaterThan(0);
  expect(brushMessage.action.mask_strokes!.brush).toBeLessThanOrEqual(1);
  expect(brushMessage.action.mask_strokes!.strokes[0].length).toBeGreaterThan(1);
  brushMessage.action.mask_strokes!.strokes.flat().forEach(expectNormalized);
  const firstPoint = brushMessage.action.mask_strokes!.strokes[0][0];
  expect(Math.abs(firstPoint.x - expectedStart.x)).toBeLessThan(.015);
  expect(Math.abs(firstPoint.y - expectedStart.y)).toBeLessThan(.015);
  const localImage = await completedChild(before, wholeImage.id);
  await expect(page.getByTestId('viewer-compare-slider')).toBeVisible();
  await shot(page, '29-local-edit-result-compare.png');
  await expect(page.getByTestId(`viewer-edit-check-${localImage.id}`)).toContainText('可能没改到位');
  await expect(page.getByTestId('viewer-retry-edit')).toBeVisible();
  await expect(page.getByTestId('viewer-rephrase-edit')).toBeVisible();
  await shot(page, '32-edit-check-failed.png');

  // Retry must preserve the exact normalized selection, including brush size.
  await close();
  await page.getByTestId(`image-select-${localImage.id}`).click();
  await expect(page.getByTestId(`viewer-edit-check-${localImage.id}`)).toContainText('可能没改到位');
  before = state()!.images.map(image => image.id);
  const retryRequest = page.waitForRequest(isEdit);
  await page.getByTestId('viewer-retry-edit').click();
  const retryMessage = (await retryRequest).postDataJSON() as EditMessage;
  expect(retryMessage.action.mask_strokes).toEqual(brushMessage.action.mask_strokes);
  expect(retryMessage.action.region).toBeUndefined();
  const retryImage = await completedChild(before, retryMessage.action.image_id);
  await expect(page.getByTestId(`viewer-edit-check-${retryImage.id}`)).not.toContainText('可能没改到位');

  // Rectangle mode sends region alone, with positive bounds in original-image space.
  await page.getByTestId('viewer-mode-local').click();
  await page.getByTestId('viewer-mode-rectangle').click();
  await page.getByTestId('viewer-zoom-reset').click();
  await drag(page, canvas, [{ x: 0.35, y: 0.35 }, { x: 0.66, y: 0.6 }]);
  await expect(page.getByTestId('viewer-region-status')).toContainText('已框选');
  await page.getByTestId('viewer-undo').click();
  await expect(page.getByTestId('viewer-region-status')).toContainText('0 个区域');
  await drag(page, canvas, [{ x: 0.35, y: 0.35 }, { x: 0.66, y: 0.6 }]);
  await page.getByTestId('viewer-clear').click();
  await expect(page.getByTestId('viewer-region-status')).toContainText('0 个区域');
  await drag(page, canvas, [{ x: 0.35, y: 0.35 }, { x: 0.66, y: 0.6 }]);
  await page.getByTestId('viewer-mode-pan').click();
  await page.getByTestId('edit-instruction').fill('背景亮一点');
  before = state()!.images.map(image => image.id);
  const rectangleMessage = await submit();
  expect(rectangleMessage.action.mask_strokes).toBeUndefined();
  expect(rectangleMessage.action.region).toBeDefined();
  const region = rectangleMessage.action.region!;
  expectNormalized(region);
  expectNormalized({ x: region.x + region.w, y: region.y + region.h });
  expect(region.w).toBeGreaterThan(0.05);
  expect(region.h).toBeGreaterThan(0.05);
  const rectangleImage = await completedChild(before, retryImage.id);
  await expect(page.getByTestId('viewer-compare-slider')).toBeVisible();
  await shot(page, '33-rectangle-edit-result.png');

  // Reference chips can be removed, and sent refs survive history re-fetching.
  await page.getByTestId('viewer-reference').click();
  await expect(page.getByTestId(`chat-ref-${rectangleImage.id}`)).toBeVisible();
  await page.getByTestId(`remove-chat-ref-${rectangleImage.id}`).click();
  await expect(page.getByTestId(`chat-ref-${rectangleImage.id}`)).not.toBeVisible();
  await page.getByTestId(`image-select-${rectangleImage.id}`).click();
  await page.getByTestId('viewer-reference').click();
  await page.getByTestId('chat-input').fill('这张袖口现在合适了，保留这个自然的感觉。');
  const lastMessageBeforeReference = state()?.last_message_id;
  const referenceRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/messages') && request.postDataJSON()?.refs?.includes(rectangleImage.id));
  await page.getByTestId('send-message').click();
  const referenceMessage = (await referenceRequest).postDataJSON();
  expect(referenceMessage.refs).toEqual([rectangleImage.id]);
  const messageReference = page.getByTestId(new RegExp(`^message-ref-.*-${rectangleImage.id}$`)).last();
  await expect(messageReference).toBeVisible();
  await expect.poll(() => state()?.last_message_id).not.toBe(lastMessageBeforeReference);
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(messageReference).toBeVisible();
  await shot(page, '30-reference-sent.png', messageReference);
  await messageReference.click();
  await expect(page.getByTestId('image-viewer')).toBeVisible();
  await close();

  const openMenu = async () => {
    await expect(page.getByTestId('image-viewer')).not.toBeVisible();
    await expect(page.getByTestId('image-menu')).not.toBeVisible();
    const thumbnail = page.getByTestId(`image-select-${rectangleImage.id}`);
    await thumbnail.click({ delay: 700, position: { x: 40, y: 60 } });
    await expect(page.getByTestId('image-menu')).toBeVisible();
  };
  await openMenu();
  for (const action of ['local', 'whole', 'reference', 'compare', 'save']) await expect(page.getByTestId(`image-menu-${action}`)).toBeVisible();
  await shot(page, '31-image-longpress-menu.png');
  await page.getByTestId('image-menu-reference').click();
  await expect(page.getByTestId(`chat-ref-${rectangleImage.id}`)).toBeVisible();
  await page.getByTestId(`remove-chat-ref-${rectangleImage.id}`).click();
  await openMenu();
  const menuDownload = page.waitForEvent('download');
  await page.getByTestId('image-menu-save').click();
  await (await menuDownload).saveAs(path.resolve('test-results/menu-saved-image'));
  await expect(page.getByTestId('image-menu')).not.toBeVisible();
  await expect(page.getByTestId('image-feedback')).toContainText('图片已保存');
  await page.getByTestId('image-feedback').click();
  await openMenu();
  await page.getByTestId('image-menu-whole').click();
  await expect(page.getByTestId('edit-instruction')).toBeVisible();
  await close();
  await shot(page, '09-image-new-version.png', page.getByText('你的穿搭影像'));
  return { firstId, wholeImageId: wholeImage.id, localImageId: localImage.id, retryImageId: retryImage.id, rectangleImageId: rectangleImage.id, brushMessage, retryMessage, rectangleMessage, referenceMessage };
}
