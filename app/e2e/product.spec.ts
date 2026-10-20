import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, Project, User } from '../src/api/types';

const shots = path.resolve(process.env.E2E_SCREENSHOTS_DIR || 'screenshots/polish');
const apiBase = 'http://localhost:19301/api';

test('首次引导、形象档案和项目管理，以及旧服务的兼容', async ({ page, request }) => {
  test.setTimeout(180_000);
  await mkdir(shots, { recursive: true });
  const errors: string[] = [];
  const screenshots: { file: string; width: number; height: number }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const uploadedModels: Asset[] = [];
  page.on('response', response => {
    if (response.request().method() === 'POST' && response.url() === `${apiBase}/assets` && response.ok()) {
      void response.json().then((asset: Asset) => { if (asset.kind === 'model') uploadedModels.push(asset); });
    }
  });
  async function shot(file: string) {
    await page.evaluate(async () => {
    await Promise.all(Array.from(document.images).filter(image => {
      const bounds = image.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight;
    }).map(image => image.decode().catch(() => undefined)));
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, file), animations: 'disabled' });
    screenshots.push({ file, ...page.viewportSize()! });
  }
  await page.goto('/');
  for (let index = 1; index <= 3; index += 1) {
    await expect(page.getByTestId(`onboarding-${index}`)).toBeVisible();
    await shot(`${35 + index}-onboarding-${index}.png`);
    await page.getByRole('button', { name: index === 3 ? '开始创作' : '下一步', exact: true }).click();
  }
  await page.reload();
  await expect(page.getByRole('button', { name: '登录，继续创作', exact: true })).toBeVisible();
  await expect(page.getByTestId('onboarding-1')).toHaveCount(0);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByLabel('怎么称呼你', { exact: true }).fill('档案小序');
  await page.getByLabel('用户名', { exact: true }).fill(`profile_${Date.now()}`);
  await page.getByLabel('密码', { exact: true }).fill('Demo-only-2026');
  await page.getByRole('button', { name: '创建账号，开始创作', exact: true }).click();
  await expect(page.getByText('档案小序的创作间', { exact: true })).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('outfit.session'));
  expect(token).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };
  async function me(): Promise<User> { const response = await request.get(`${apiBase}/me`, { headers }); expect(response.ok()).toBe(true); return response.json(); }

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByText('我的形象', { exact: true })).toBeVisible();
  await shot('53-settings.png');
  const fixture = await readFile(path.resolve('../docs/spike/inputs.jpg'));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加本人照片', exact: true }).click();
  await (await chooser).setFiles(['a', 'b', 'c'].map(name => ({ name: `portrait-${name}.jpg`, mimeType: 'image/jpeg', buffer: fixture })));
  await expect(page.getByRole('button', { name: '删除本人照片 3', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存我的形象', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '设照片 2 为默认', exact: true }).click();
  await page.getByRole('button', { name: '删除本人照片 3', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除本人照片 3', exact: true })).toHaveCount(0);
  await page.getByLabel('昵称', { exact: true }).fill('松弛小序');
  await page.getByLabel('身高（厘米）', { exact: true }).fill('168');
  await page.getByLabel('体型描述', { exact: true }).fill('肩略宽，希望突出腰线');
  await page.getByLabel('风格偏好', { exact: true }).fill('喜欢松弛感，不穿高跟鞋');
  await page.getByRole('button', { name: '保存我的形象', exact: true }).click();
  await expect(page.getByText('形象已保存，新建合作会默认带上你的照片。')).toBeVisible();
  const profileUser = await me();
  expect(profileUser.nickname).toBe('松弛小序');
  expect(profileUser.profile?.model_asset_ids).toHaveLength(2);
  expect(uploadedModels).toHaveLength(3);
  expect(profileUser.profile?.model_asset_ids).toEqual([uploadedModels[1].id, uploadedModels[0].id]);
  expect(profileUser.profile?.height_cm).toBe(168);
  expect(profileUser.profile?.style_notes).toBe('喜欢松弛感，不穿高跟鞋');
  await page.reload();
  await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('松弛小序');
  await expect(page.getByLabel('体型描述', { exact: true })).toHaveValue('肩略宽，希望突出腰线');
  const portrait = page.getByLabel('本人照片 1', { exact: true });
  await expect(portrait).toBeVisible();
  await expect.poll(() => portrait.evaluate(element => {
    const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
    return !!image?.complete && image.naturalWidth > 0;
  })).toBe(true);
  await portrait.scrollIntoViewIfNeeded();
  await shot('39-profile-photos-default.png');

  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByText('松弛小序的创作间')).toBeVisible();
  await page.getByRole('button', { name: '新建品牌合作', exact: true }).click();
  const firstProfile = page.getByRole('button', { name: '选择档案照片 1', exact: true });
  const secondProfile = page.getByRole('button', { name: '选择档案照片 2', exact: true });
  await expect(firstProfile).toContainText('档案默认 ✓');
  await firstProfile.scrollIntoViewIfNeeded();
  await shot('40-new-project-default-profile.png');
  await secondProfile.click();
  await expect(secondProfile).toContainText('照片 2 ✓');
  await expect(firstProfile).not.toContainText('✓');
  await page.getByLabel('项目名称', { exact: true }).fill('档案换图合作');
  await page.getByLabel('合作品牌', { exact: true }).fill('PROFILE');
  await page.getByLabel('品牌需求', { exact: true }).fill('使用选择的第二张本人照片');
  const garmentChooser = page.waitForEvent('filechooser');
  await page.getByTestId('upload-garments').click();
  await (await garmentChooser).setFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: fixture });
  await expect(page.getByRole('button', { name: '移除衣服图 1', exact: true })).toBeVisible();
  const creation = page.waitForRequest(value => value.url() === `${apiBase}/projects` && value.method() === 'POST');
  await page.getByRole('button', { name: '开始聊灵感', exact: true }).click();
  expect((await creation).postDataJSON().model_asset_id).toBe(profileUser.profile?.model_asset_ids[1]);
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();

  const upload = await request.post(`${apiBase}/assets`, { headers, multipart: { kind: 'garment', file: { name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: fixture } } });
  expect(upload.ok()).toBe(true);
  const garment = await upload.json() as Asset;
  async function create(title: string, brand: string): Promise<Project> {
    const response = await request.post(`${apiBase}/projects`, { headers, data: { title, brand, brief: '本地项目管理测试', garment_asset_ids: [garment.id] } });
    expect(response.ok()).toBe(true); return response.json();
  }
  const autumn = await create('秋日衬衫合作', 'SOFT STUDIO');
  const office = await create('通勤外套合作', 'ARKET');
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await expect(page.getByRole('button', { name: `打开项目 ${autumn.title}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `打开项目 ${office.title}`, exact: true })).toBeVisible();
  const search = page.getByRole('textbox', { name: '搜索项目', exact: true });
  await search.fill(' 秋日 ');
  await expect(page.getByRole('button', { name: `打开项目 ${autumn.title}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `打开项目 ${office.title}`, exact: true })).toHaveCount(0);
  await search.fill('arket');
  await expect(page.getByRole('button', { name: `打开项目 ${office.title}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `打开项目 ${autumn.title}`, exact: true })).toHaveCount(0);
  await search.scrollIntoViewIfNeeded();
  await shot('41-project-search-brand.png');
  await search.fill('');
  await page.getByRole('button', { name: `删除项目 ${autumn.title}`, exact: true }).click();
  await expect(page.getByText('删除这个合作项目？')).toBeVisible();
  await expect.poll(() => page.getByText('删除这个合作项目？').evaluate(element => {
    for (let current: Element | null = element; current; current = current.parentElement) if (Number(getComputedStyle(current).opacity) < 0.99) return false;
    return true;
  })).toBe(true);
  await shot('42-project-delete-confirmation.png');
  await page.getByRole('button', { name: '保留项目', exact: true }).click();
  await expect(page.getByText('删除这个合作项目？')).toBeHidden();
  await page.getByRole('button', { name: `打开项目 ${autumn.title}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${autumn.id}$`));
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('button', { name: `打开项目 ${autumn.title}`, exact: true })).toBeVisible();
  expect((await request.get(`${apiBase}/projects/${autumn.id}`, { headers })).ok()).toBe(true);
  // 长按也能进入同一确认面板。
  const card = page.getByRole('button', { name: `打开项目 ${autumn.title}`, exact: true });
  await card.scrollIntoViewIfNeeded();
  const cardBox = (await card.boundingBox())!;
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await expect(page.getByText('删除这个合作项目？')).toBeVisible();
  await page.mouse.up();
  await expect(page).toHaveURL('http://localhost:19300/');
  await page.getByRole('button', { name: '确认删除项目', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await request.get(`${apiBase}/projects/${autumn.id}`, { headers })).status()).toBe(404);
  expect((await request.get(`${apiBase}/projects/${autumn.id}/state`, { headers })).status()).toBe(404);
  expect((await request.get(`${apiBase}/projects/${autumn.id}/messages`, { headers })).status()).toBe(404);
  await search.scrollIntoViewIfNeeded();
  await shot('42-project-delete-completed.png');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于衣序与隐私', exact: true }).click();
  await expect(page.getByTestId('app-version')).toContainText('1.0.0');
  await expect(page.getByText('隐私说明', { exact: true })).toBeVisible();
  await shot('43-about-privacy.png');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.route('**/api/me', async route => {
    if (route.request().method() === 'PATCH') return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '当前服务未开通我的形象' } } });
    return route.continue();
  });
  await page.getByRole('button', { name: '保存我的形象', exact: true }).click();
  await expect(page.getByText('当前服务未开通我的形象，其他创作功能可以继续使用。')).toBeVisible();
  await shot('43-profile-patch-404.png');
  await page.unroute('**/api/me');
  await page.route('**/api/me', async route => {
    const response = await route.fetch();
    const user = await response.json() as User;
    const { id, username, nickname, created_at } = user;
    return route.fulfill({ response, json: { id, username, nickname, created_at } });
  });
  await page.reload();
  await expect(page.getByText('当前服务未开通我的形象，现有创作功能可以继续使用。')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存我的形象', exact: true })).toHaveCount(0);
  await shot('43-profile-old-fields.png');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('button', { name: `打开项目 ${office.title}`, exact: true })).toBeVisible();
  await page.route('**/api/me', route => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '当前服务未开通' } } }));
  await page.reload();
  await expect(page.getByRole('button', { name: `打开项目 ${office.title}`, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await writeFile(path.join(shots, 'product-evidence.json'), JSON.stringify({ completedAt: new Date().toISOString(), viewport: '390×844', screenshots, checks: { onboardingThreeScreens: true, onboardingPersistsAfterRefresh: true, nicknameAndProfilePersist: true, localPhotoPreviewAfterRefresh: true, photoCount: 2, defaultPhotoSelectableInNewProject: true, titleAndBrandSearch: true, refresh: true, deleteCancelled: true, deleteConfirmed: true, deletedProjectEndpoints404: true, aboutPrivacy: true, patch404Graceful: true, oldMeFieldsGraceful: true, me404PreservesProjects: true }, pageErrors: errors }, null, 2));
});
