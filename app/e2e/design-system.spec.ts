import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const designBase = process.env.E2E_DESIGN_BASE || 'http://localhost:19422';
const screenshots = path.resolve(process.env.E2E_DESIGN_SCREENSHOTS_DIR || 'screenshots/ds');

async function openGallery(page: Page, tone: 'paper' | 'studio', width: number) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(base => {
    sessionStorage.setItem('outfit.session', 'gallery-isolated-test-session');
    localStorage.setItem('outfit.server', base);
  }, process.env.E2E_MOCK_BASE || 'http://localhost:19421');
  await page.goto(`${designBase}/__design`);
  await expect(page.getByTestId('YIXU_DS_GALLERY_ONLY')).toBeVisible();
  await page.getByRole('tablist', { name: '主题', exact: true }).getByRole('tab', { name: tone, exact: true }).click();
  await page.getByRole('tablist', { name: '宽度', exact: true }).getByRole('tab', { name: String(width), exact: true }).click();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(image => image.decode().catch(() => undefined)));
  });
  await expect(page.getByTestId('design-content')).toHaveCSS('width', `${width}px`);
}

async function expandGallery(page: Page, width: number) {
  const bounds = await page.getByTestId('design-content').boundingBox();
  expect(bounds).not.toBeNull();
  await page.setViewportSize({ width, height: Math.ceil(bounds!.y + bounds!.height + 32) });
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect.poll(() => page.getByTestId('design-content').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
}

for (const tone of ['paper', 'studio'] as const) {
  for (const width of [320, 390]) {
    test(`衣序 DS · ${tone} / ${width}`, async ({ page }) => {
      const errors: string[] = [];
      const apiRequests: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
      await openGallery(page, tone, width);
      await expandGallery(page, width);
      await expect(page.getByTestId('design-button-primary-loading')).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByTestId('design-button-secondary-disabled')).toBeDisabled();
      await expect(page.getByTestId('design-field-disabled')).toBeDisabled();
      await expect(page.getByTestId('design-toast-info')).toBeVisible();
      if (process.platform === 'darwin') {
        await expect(page).toHaveScreenshot(`${tone}-${width}.png`, { fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0, threshold: 0.1 });
      } else {
        test.info().annotations.push({ type: 'pixel-baseline', description: '仓库像素基线使用 macOS 系统字体；其他平台执行结构与状态检查，并留存实际截图。' });
      }
      await mkdir(screenshots, { recursive: true });
      const screenshotPath = path.join(screenshots, `${tone}-${width}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' });
      if (process.platform !== 'darwin') await test.info().attach(`${tone}-${width}`, { path: screenshotPath, contentType: 'image/png' });
      expect(errors).toEqual([]);
      expect(apiRequests).toEqual([]);
    });
  }
}

test('画廊的 1.3 字号、44 触控和真实 Sheet 关闭路径', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openGallery(page, 'studio', 320);
  await page.getByRole('tablist', { name: '字号', exact: true }).getByRole('tab', { name: '1.3', exact: true }).click();
  await expect(page.getByTestId('design-button-primary-default').getByText('开始创作', { exact: true })).toHaveCSS('font-size', '19.5px');
  await expandGallery(page, 320);
  const violations = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"], [role="checkbox"], input, textarea'));
    return items.flatMap(item => {
      const bounds = item.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return [];
      const label = item.getAttribute('aria-label') || item.textContent?.trim();
      return !label || bounds.width < 43.5 || bounds.height < 43.5 ? [{ label, width: bounds.width, height: bounds.height }] : [];
    });
  });
  expect(violations).toEqual([]);
  const overflow = await page.getByTestId('design-content').evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 320, height: 844 });
  const open = page.getByTestId('design-open-sheet');
  const dialog = page.getByRole('dialog', { name: '片场操作演示', exact: true });
  await open.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭片场操作演示', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await open.click();
  await expect(page.locator('[aria-modal="true"][role="dialog"]').filter({ has: dialog })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await open.click();
  await page.getByRole('button', { name: '关闭片场操作演示遮罩', exact: true }).click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('正式模式路由没有画廊页面', async ({ page }) => {
  await page.goto('/__design');
  await expect(page.getByRole('heading', { name: 'Unmatched Route', exact: true })).toBeVisible();
  await expect(page.getByTestId('YIXU_DS_GALLERY_ONLY')).toHaveCount(0);
  await expect(page.getByText('衣序 DS', { exact: true })).toHaveCount(0);
});
