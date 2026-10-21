import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Action, Asset, AuthResponse, CreateProjectInput, Project, ProjectState, User } from '../src/api/types';
import type { AssetPage, LibraryKind, SavedModel } from '../src/lib/assets';

const shots = path.resolve('screenshots');
const evidence: Record<string, unknown> = {};

async function screenshot(page: Page, filename: string, focus?: Locator) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).filter(image => {
      const box = image.getBoundingClientRect();
      return box.width && box.height && box.bottom > 0 && box.top < innerHeight;
    }).map(image => image.decode().catch(() => undefined)));
  });
  await page.waitForTimeout(250);
  expect(await page.locator('body').innerText()).not.toMatch(/资产|asset|¥|元/i);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, filename), animations: 'disabled' });
}

async function touchSize(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function record(name: string, value: unknown) {
  evidence[name] = value;
  await mkdir(shots, { recursive: true });
  await writeFile(path.join(shots, 'round12-evidence.json'), JSON.stringify(evidence, null, 2));
}

async function setup(page: Page, request: APIRequestContext, label: string, options: { legacyAssets?: boolean; profile?: boolean } = {}) {
  const dataRoot = path.resolve('mock-server/.data/tests');
  await mkdir(dataRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(dataRoot, 'round12-browser-'));
  const { createMockServer } = await import('../mock-server/index.mjs');
  const server = await createMockServer({ dataDir, legacyAssets: options.legacyAssets, tokenDelayMs: 0, previewDelayMs: 1, previewStaggerMs: 0, imageDelayMs: 1, imageStaggerMs: 0, editDelayMs: 1, runningDelayMs: 0, workerIntervalMs: 10 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地假服务未启动');
  const base = `http://127.0.0.1:${address.port}`;
  const registered = await request.post(`${base}/api/auth/register`, { data: { username: `round12_${label}_${Date.now()}`, password: 'Local-round12-2026', nickname: '素材库验收' } });
  expect(registered.ok()).toBe(true);
  const auth = await registered.json() as AuthResponse;
  const headers = { Authorization: `Bearer ${auth.token}` };
  const fixture = await readFile(path.resolve('../docs/spike/inputs.jpg'));
  async function upload(kind: 'garment' | 'model') {
    const response = await request.post(`${base}/api/assets`, { headers, multipart: { kind, file: { name: `${kind}.jpg`, mimeType: 'image/jpeg', buffer: fixture } } });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Asset>;
  }
  const garment = await upload('garment');
  const model = await upload('model');
  if (options.profile !== false) {
    const response = await request.patch(`${base}/api/me`, { headers, data: { profile: { model_asset_ids: [model.id] } } });
    expect(response.ok()).toBe(true);
  }
  const created = await request.post(`${base}/api/projects`, { headers, data: { title: '操场那组的她', brand: '自由创作', brief: '自然光下的浅色衬衫，保留衣服细节。', garment_asset_ids: [garment.id] } });
  expect(created.ok()).toBe(true);
  const project = await created.json() as Project;
  async function state() {
    const response = await request.get(`${base}/api/projects/${project.id}/state`, { headers });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<ProjectState>;
  }
  async function send(body: { text?: string; action?: Action }) {
    const response = await request.post(`${base}/api/projects/${project.id}/messages`, { headers, data: body });
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toContain('event: error');
  }
  await send({ text: '帮我找几个拍摄方向。' });
  await send({ action: { type: 'choose_direction', direction_id: (await state()).directions[0].id } });
  await send({ action: { type: 'confirm_script' } });
  await expect.poll(async () => {
    const current = await state();
    return current.images.length >= 3 && current.images.every(image => image.status === 'succeeded') && current.active_jobs.length === 0;
  }).toBe(true);
  const images = (await state()).images;
  const errors: string[] = [];
  const savedRequests: string[] = [];
  const uploadedRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => {
    if (value.method() !== 'POST') return;
    if (value.url() === `${base}/api/me/models/from-image`) savedRequests.push(value.postDataJSON().image_id);
    if (value.url() === `${base}/api/assets`) uploadedRequests.push(value.url());
  });
  await page.addInitScript(({ token, baseUrl }) => {
    sessionStorage.setItem('outfit.session', token);
    localStorage.setItem('outfit.server', baseUrl);
    localStorage.setItem('outfit.privacy-consent', '2026-10-21');
    localStorage.setItem('outfit.onboarding.v1', 'done');
  }, { token: auth.token, baseUrl: base });
  async function assets(kind: LibraryKind) {
    const response = await request.get(`${base}/api/me/assets?kind=${kind}&limit=100&offset=0`, { headers });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<AssetPage>;
  }
  async function me() {
    const response = await request.get(`${base}/api/me`, { headers });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<User>;
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  return { base, headers, project, garment, model, images, errors, savedRequests, uploadedRequests, assets, me, close };
}

test('第十二轮：成片两处存模特、默认出镜与衣服跨项目复用', async ({ page, request }) => {
  const context = await setup(page, request, 'reuse');
  try {
    const [first, second] = context.images;
    await page.goto(`/projects/${context.project.id}`);
    const cardSave = page.getByTestId(`save-model-${first.id}`);
    await expect(cardSave).toBeVisible();
    await touchSize(cardSave);
    const savedResponse = page.waitForResponse(value => value.url() === `${context.base}/api/me/models/from-image` && value.request().method() === 'POST');
    await cardSave.click();
    const saved = await (await savedResponse).json() as SavedModel;
    await expect(cardSave).toHaveText('已在我的模特');
    await expect(cardSave).toBeDisabled();
    expect(saved.asset.source).toBe('generated');
    expect(saved.asset.parent_id).toBe(new URL(first.url!).pathname.split('/').at(-1));
    await screenshot(page, '140-card-saved-model.png', cardSave);
    await page.getByTestId(`image-select-${first.id}`).click();
    const viewer = page.getByTestId('image-viewer');
    await expect(viewer.getByTestId(`save-model-${first.id}`)).toBeDisabled();
    expect(context.savedRequests).toEqual([first.id]);
    await page.getByTestId('viewer-close').click();
    await page.getByTestId(`image-select-${second.id}`).click();
    const secondResponse = page.waitForResponse(value => value.url() === `${context.base}/api/me/models/from-image` && value.request().method() === 'POST');
    await viewer.getByTestId(`save-model-${second.id}`).click();
    const savedSecond = await (await secondResponse).json() as SavedModel;
    await expect(viewer.getByTestId(`save-model-${second.id}`)).toBeDisabled();
    await screenshot(page, '141-viewer-saved-model.png');
    await page.getByTestId('viewer-close').click();
    await page.reload();
    await expect(page.getByTestId(`save-model-${first.id}`)).toBeDisabled();
    expect(context.savedRequests).toEqual([first.id, second.id]);
    const duplicate = await request.post(`${context.base}/api/me/models/from-image`, { headers: context.headers, data: { image_id: first.id } });
    expect((await duplicate.json() as SavedModel).asset.id).toBe(saved.asset.id);
    expect((await context.assets('model')).total).toBe(3);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '素材库', exact: true }).click();
    const tile = page.getByTestId(`library-${saved.asset.id}`);
    await expect(tile).toContainText('成片');
    await expect(page.getByTestId(`library-${context.model.id}`)).toContainText('上传');
    await touchSize(page.getByRole('tab', { name: '我的模特', exact: true }));
    await touchSize(tile.getByRole('button', { name: '设为默认', exact: true }));
    await tile.getByRole('button', { name: '设为默认', exact: true }).click();
    await expect.poll(async () => (await context.me()).profile?.model_asset_ids[0]).toBe(saved.asset.id);
    await expect(tile).toContainText('默认');
    await screenshot(page, '142-library-default-model.png', tile);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '拍一组新片', exact: true }).click();
    const defaultPhoto = page.getByRole('button', { name: '选择档案照片 1', exact: true });
    await expect(defaultPhoto).toContainText('档案默认 ✓');
    await expect(defaultPhoto).toContainText('成片');
    await screenshot(page, '152-new-project-model-source.png', defaultPhoto);
    await page.getByRole('button', { name: '从我的衣服里选', exact: true }).click();
    const garment = page.getByTestId(`pick-garment-${context.garment.id}`);
    await expect(garment).toBeVisible();
    await touchSize(garment);
    await screenshot(page, '143-reuse-garment-picker.png', garment);
    await garment.click();
    await expect(page.getByRole('button', { name: '移除衣服图 1', exact: true })).toBeVisible();
    await page.getByLabel('这次想拍什么', { exact: true }).fill('同一位模特，穿这件衣服拍一组街角新片。');
    const creation = page.waitForRequest(value => value.method() === 'POST' && value.url() === `${context.base}/api/projects`);
    await page.getByTestId('start-shooting').click();
    const input = (await creation).postDataJSON() as CreateProjectInput;
    expect(input.garment_asset_ids).toEqual([context.garment.id]);
    expect(input.model_asset_id).toBe(saved.asset.id);
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '素材库', exact: true }).click();
    await page.getByRole('tab', { name: '我的衣服', exact: true }).click();
    await page.getByTestId(`library-${context.garment.id}`).getByRole('button', { name: '用这件拍一组新片', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`garment=${context.garment.id}`));
    await expect(page.getByRole('button', { name: '移除衣服图 1', exact: true })).toBeVisible();
    await screenshot(page, '144-library-garment-prefilled.png', page.getByRole('button', { name: '移除衣服图 1', exact: true }));
    expect(context.uploadedRequests).toEqual([]);
    expect(context.errors).toEqual([]);
    await record('reuse', { savedFromCard: saved.asset.id, savedFromViewer: savedSecond.asset.id, requests: context.savedRequests, modelCount: 3, submittedModel: input.model_asset_id, reusedGarment: input.garment_asset_ids, uploads: 0, pageErrors: context.errors });
  } finally { await context.close(); }
});

test('第十二轮：素材库加载、空态、删除确认、引用保护与成片大图', async ({ page, request }) => {
  const context = await setup(page, request, 'library', { profile: false });
  let release = () => {};
  try {
    const response = await request.post(`${context.base}/api/me/models/from-image`, { headers: context.headers, data: { image_id: context.images[0].id, name: '备选出镜' } });
    const saved = await response.json() as SavedModel;
    await page.goto('/');
    await expect(page.getByRole('button', { name: '素材库', exact: true })).toBeVisible();
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`${context.base}/api/me/assets?kind=model*`, async route => { await gate; await route.continue(); });
    await page.goto('/assets');
    await expect(page.getByRole('progressbar', { name: '正在加载素材库', exact: true })).toBeVisible();
    await screenshot(page, '145-library-loading.png');
    release();
    const tile = page.getByTestId(`library-${saved.asset.id}`);
    await expect(tile).toBeVisible();
    await page.unroute(`${context.base}/api/me/assets?kind=model*`);
    await page.reload();
    await expect(tile).toBeVisible();
    const frame = page.getByTestId(`library-image-${saved.asset.id}`);
    const box = await frame.boundingBox();
    expect(box!.width / box!.height).toBeCloseTo(3 / 4, 2);
    await touchSize(tile.getByRole('button', { name: '删除', exact: true }));
    await tile.getByRole('button', { name: '删除', exact: true }).click();
    const confirmation = page.getByTestId('library-delete-confirmation');
    await expect(confirmation).toBeVisible();
    await screenshot(page, '146-library-delete-confirmation.png');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(tile).toBeVisible();
    expect((await context.assets('model')).items.some(item => item.id === saved.asset.id)).toBe(true);
    for (const id of [saved.asset.id, context.model.id]) {
      await page.getByTestId(`library-${id}`).getByRole('button', { name: '删除', exact: true }).click();
      const deletion = page.waitForResponse(value => value.request().method() === 'DELETE' && value.url() === `${context.base}/api/me/assets/${id}`);
      await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
      expect((await deletion).status()).toBe(204);
      await expect(page.getByTestId(`library-${id}`)).toHaveCount(0);
    }
    expect((await context.me()).profile?.model_asset_ids).toEqual([]);
    await expect(page.getByText('拍过的片都会留在这里', { exact: true })).toBeVisible();
    await screenshot(page, '147-library-empty-models.png');
    await page.getByRole('tab', { name: '我的衣服', exact: true }).click();
    const garment = page.getByTestId(`library-${context.garment.id}`);
    await garment.getByRole('button', { name: '删除', exact: true }).click();
    const conflict = page.waitForResponse(value => value.request().method() === 'DELETE' && value.url() === `${context.base}/api/me/assets/${context.garment.id}`);
    await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(page.getByText(`这件衣服仍被这些片场使用：${context.project.title}`, { exact: true })).toBeVisible();
    await expect(garment).toBeVisible();
    await screenshot(page, '148-library-garment-in-use.png', garment);
    await page.getByRole('tab', { name: '我的成片', exact: true }).click();
    const images = await context.assets('image');
    expect(images.total).toBeGreaterThanOrEqual(3);
    const image = images.items[0];
    const imageTile = page.getByTestId(`library-${image.id}`);
    await expect(imageTile).toBeVisible();
    await expect(imageTile.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
    await page.getByTestId(`library-image-${image.id}`).click();
    const preview = page.getByTestId('library-preview');
    await expect(preview.getByLabel('素材库大图', { exact: true })).toBeVisible();
    await screenshot(page, '149-library-image-preview.png');
    await preview.getByRole('button', { name: '关闭大图', exact: true }).click();
    await expect(preview).not.toBeVisible();
    await imageTile.getByRole('button', { name: '回到这组片', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${context.project.id}$`));
    expect(context.errors).toEqual([]);
    await record('library', { loading: true, empty: true, directRouteAndReload: true, aspectRatio: box!.width / box!.height, cancelledDeletionPreserved: true, confirmedDeletions: 2, garmentConflictStatus: 409, imageCount: images.total, pageErrors: context.errors });
  } finally { release(); await context.close(); }
});

test('第十二轮：旧服务 GET 404 隐藏素材库、衣服选择与存模特', async ({ page, request }) => {
  const context = await setup(page, request, 'legacy', { legacyAssets: true });
  try {
    const probe = page.waitForResponse(value => value.url().includes('/api/me/assets?kind=model'));
    await page.goto('/');
    expect((await probe).status()).toBe(404);
    await expect(page.getByRole('button', { name: '素材库', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '素材库', exact: true })).toHaveCount(0);
    await page.goto('/projects/new');
    await expect(page.getByTestId('start-shooting')).toBeVisible();
    await expect(page.getByRole('button', { name: '从我的衣服里选', exact: true })).toHaveCount(0);
    await page.goto(`/projects/${context.project.id}`);
    await expect(page.getByTestId(`image-select-${context.images[0].id}`)).toBeVisible();
    await expect(page.getByTestId(/^save-model-/)).toHaveCount(0);
    await page.getByTestId(`image-select-${context.images[0].id}`).click();
    await expect(page.getByTestId('image-viewer')).toBeVisible();
    await expect(page.getByTestId(/^save-model-/)).toHaveCount(0);
    await screenshot(page, '150-legacy-library-actions-hidden.png');
    expect(context.savedRequests).toEqual([]);
    expect(context.errors).toEqual([]);
    await record('legacy', { probeStatus: 404, libraryHiddenAtHomeAndSettings: true, pickerHidden: true, cardAndViewerSaveHidden: true, pageErrors: context.errors });
  } finally { await context.close(); }
});

test('第十二轮：存模特 POST 404 立即收起当前会话全部入口', async ({ page, request }) => {
  const context = await setup(page, request, 'post404');
  try {
    await page.route(`${context.base}/api/me/models/from-image`, route => route.request().method() === 'POST' ? route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, json: { error: { code: 'NOT_FOUND', message: '当前服务未开通素材库' } } }) : route.continue());
    await page.goto(`/projects/${context.project.id}`);
    const button = page.getByTestId(`save-model-${context.images[0].id}`);
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId(/^save-model-/)).toHaveCount(0);
    await page.getByTestId(`image-select-${context.images[1].id}`).click();
    await expect(page.getByTestId('image-viewer')).toBeVisible();
    await expect(page.getByTestId(/^save-model-/)).toHaveCount(0);
    await screenshot(page, '151-post404-actions-hidden.png');
    await page.getByTestId('viewer-close').click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('button', { name: '拍一组新片', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '素材库', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '素材库', exact: true })).toHaveCount(0);
    expect(context.savedRequests).toEqual([context.images[0].id]);
    expect(context.errors).toEqual([]);
    await record('post404', { cardAndViewerSaveHidden: true, libraryHiddenAtHomeAndSettings: true, requests: 1, pageErrors: context.errors });
  } finally { await context.close(); }
});
