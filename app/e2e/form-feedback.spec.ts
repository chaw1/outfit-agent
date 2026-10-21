import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Asset, AuthResponse, CreateProjectInput } from '../src/api/types';
import { LEGAL_VERSION, PRIVACY_CONSENT_KEY } from '../src/lib/legalConsent';

async function setup(page: Page, request: APIRequestContext) {
  const dataDir = test.info().outputPath('mock-data');
  await mkdir(dataDir, { recursive: true });
  const { createMockServer } = await import('../mock-server/index.mjs');
  const server = await createMockServer({ dataDir, tokenDelayMs: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地假服务未启动');
  const base = `http://127.0.0.1:${address.port}`;
  const registered = await request.post(`${base}/api/auth/register`, {
    data: { username: `form_${Date.now()}`, password: 'Local-form-2026', nickname: '表单验收' },
  });
  expect(registered.ok()).toBe(true);
  const auth = await registered.json() as AuthResponse;
  const headers = { Authorization: `Bearer ${auth.token}` };
  await page.addInitScript(({ token, baseUrl, legalVersion, privacyKey }) => {
    sessionStorage.setItem('outfit.session', token);
    localStorage.setItem('outfit.server', baseUrl);
    localStorage.setItem('outfit.onboarding.v1', 'done');
    localStorage.setItem(privacyKey, legalVersion);
  }, { token: auth.token, baseUrl: base, legalVersion: LEGAL_VERSION, privacyKey: PRIVACY_CONSENT_KEY });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  return { base, headers, errors, close };
}

test('新建反馈始终可见，分批上传与素材库复用最多十张衣服', async ({ page, request }) => {
  const context = await setup(page, request);
  const creations: CreateProjectInput[] = [];
  let uploads = 0;
  page.on('request', value => {
    if (value.method() !== 'POST') return;
    if (value.url() === `${context.base}/api/projects`) creations.push(value.postDataJSON());
    if (value.url() === `${context.base}/api/assets`) uploads += 1;
  });
  try {
    await page.goto('/projects/new');
    const start = page.getByTestId('start-shooting');
    await start.click();
    await expect(page.getByRole('alert').filter({ hasText: '写一点这次想拍什么' })).toBeInViewport();
    expect(creations).toEqual([]);
    await page.getByLabel('这次想拍什么', { exact: true }).fill('自然光下的浅色衬衫');
    await start.click();
    await expect(page.getByRole('alert').filter({ hasText: '先上传至少一张衣服图' })).toBeInViewport();
    expect(creations).toEqual([]);

    const fixture = await readFile(path.resolve('../docs/spike/inputs.jpg'));
    async function upload(count: number) {
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('upload-garments').click();
      await (await chooser).setFiles(Array.from({ length: count }, (_, index) => ({
        name: `garment-${uploads}-${index}.jpg`, mimeType: 'image/jpeg', buffer: fixture,
      })));
    }
    await upload(9);
    await expect(page.getByTestId('garment-count')).toContainText('9/10');
    await upload(2);
    await expect(page.getByTestId('garment-count')).toContainText('10/10');
    expect(uploads).toBe(10);
    await expect(page.getByTestId('upload-garments')).toBeDisabled();
    const picker = page.getByRole('button', { name: '从我的衣服里选', exact: true });
    await expect(picker).toBeDisabled();

    await page.getByRole('button', { name: '移除衣服图 1', exact: true }).click();
    await expect(page.getByTestId('garment-count')).toContainText('9/10');
    await picker.click();
    await page.getByTestId(/^pick-garment-/).filter({ hasText: '用这件拍一组新片' }).click();
    await expect(page.getByTestId('garment-count')).toContainText('10/10');
    await expect(picker).toBeDisabled();
    await expect(page.getByTestId('upload-garments')).toBeDisabled();
    expect(uploads).toBe(10);
    await page.screenshot({ path: test.info().outputPath('garment-limit.png'), animations: 'disabled' });
    await start.click();
    await expect(page).toHaveURL(/\/projects\/(?!new)[^/]+$/);
    expect(creations).toHaveLength(1);
    expect(creations[0].garment_asset_ids).toHaveLength(10);
    expect(new Set(creations[0].garment_asset_ids).size).toBe(10);
    expect(context.errors).toEqual([]);
  } finally { await context.close(); }
});

test('保存形象期间锁定字段，后续编辑撤销已保存提示', async ({ page, request }) => {
  const context = await setup(page, request);
  let releaseSave = () => {};
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  await page.route(`${context.base}/api/me`, async route => {
    if (route.request().method() === 'PATCH') await saveGate;
    await route.continue();
  });
  try {
    await page.goto('/settings');
    const nickname = page.getByLabel('昵称', { exact: true });
    const height = page.getByLabel('身高（厘米）', { exact: true });
    const body = page.getByLabel('体型描述', { exact: true });
    const style = page.getByLabel('风格偏好', { exact: true });
    await nickname.fill('已保存的昵称');
    await height.fill('168');
    await body.fill('突出腰线');
    await style.fill('喜欢自然光');
    const sent = page.waitForRequest(value => value.url() === `${context.base}/api/me` && value.method() === 'PATCH');
    await page.getByRole('button', { name: '保存我的形象', exact: true }).click();
    await sent;
    for (const field of [nickname, height, body, style]) await expect(field).not.toBeEditable();
    releaseSave();
    await expect(page.getByText('形象已保存，拍新片会默认带上你的照片。', { exact: true })).toBeVisible();
    await expect(nickname).toBeEditable();
    await nickname.fill('还未保存的新昵称');
    await expect(page.getByText('形象已保存，拍新片会默认带上你的照片。', { exact: true })).toHaveCount(0);
    const current = await request.get(`${context.base}/api/me`, { headers: context.headers });
    expect((await current.json()).nickname).toBe('已保存的昵称');
    expect(context.errors).toEqual([]);
  } finally { releaseSave(); await context.close(); }
});

test('已有片场先呈现搜索与项目，搜索时收起灵感墙且项目操作互不嵌套', async ({ page, request }) => {
  const context = await setup(page, request);
  try {
    const uploaded = await request.post(`${context.base}/api/assets`, {
      headers: context.headers,
      multipart: { kind: 'garment', file: { name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: await readFile(path.resolve('../docs/spike/inputs.jpg')) } },
    });
    expect(uploaded.ok()).toBe(true);
    const garment = await uploaded.json() as Asset;
    const title = '秋日通勤这一组';
    const created = await request.post(`${context.base}/api/projects`, {
      headers: context.headers,
      data: { title, brand: '自由创作', brief: '浅色衬衫的通勤穿搭', garment_asset_ids: [garment.id] },
    });
    expect(created.ok()).toBe(true);
    await page.goto('/');
    const search = page.getByLabel('搜索片场', { exact: true });
    const project = page.getByRole('button', { name: `打开这组片 ${title}`, exact: true });
    const wall = page.getByTestId('inspiration-wall');
    await expect(search).toBeInViewport();
    await expect(project).toBeInViewport();
    await expect(wall).toBeAttached();
    const searchBounds = await search.boundingBox();
    const projectBounds = await project.boundingBox();
    const wallBounds = await wall.boundingBox();
    expect(searchBounds!.y + searchBounds!.height).toBeLessThan(wallBounds!.y);
    expect(projectBounds!.y + projectBounds!.height).toBeLessThan(wallBounds!.y);
    await expect(page.locator('button button, [role="button"] [role="button"]')).toHaveCount(0);
    await search.fill('秋日通勤');
    await expect(project).toBeVisible();
    await expect(wall).toHaveCount(0);
    await search.fill('没有这组片');
    await expect(page.getByText('没有找到这组片。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '清空搜索', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(wall).toBeAttached();
    await page.getByRole('button', { name: `删除这组片 ${title}`, exact: true }).click();
    await expect(page.getByText('删除这组片？', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保留这组片', exact: true }).click();
    await expect(project).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(context.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('homepage-projects-first.png'), animations: 'disabled' });
  } finally { await context.close(); }
});
