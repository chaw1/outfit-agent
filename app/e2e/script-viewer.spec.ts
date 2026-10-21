import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Action, Asset, AuthResponse, Message, Project, ProjectMode, ProjectState, ScriptData } from '../src/api/types';
import { LEGAL_VERSION, PRIVACY_CONSENT_KEY } from '../src/lib/legalConsent';

async function setup(page: Page, request: APIRequestContext, mode: ProjectMode) {
  const dataRoot = path.resolve('mock-server/.data/tests');
  await mkdir(dataRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(dataRoot, 'script-viewer-'));
  let now = Date.now();
  const { createMockServer } = await import('../mock-server/index.mjs');
  // The clock only moves when the test advances a workflow step. Opening a
  // script during generation can therefore be checked without racing a job.
  const server = await createMockServer({
    dataDir, clock: () => now, tokenDelayMs: 0, runningDelayMs: 0,
    previewDelayMs: 10, previewStaggerMs: 0, imageDelayMs: 10_000,
    imageStaggerMs: 0, editDelayMs: 100, videoDelayMs: 100, autoStepDelayMs: 100, workerIntervalMs: 10,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地假服务未启动');
  const base = `http://127.0.0.1:${address.port}`;
  const registered = await request.post(`${base}/api/auth/register`, {
    data: { username: `script_${mode}_${now}`, password: 'Local-script-2026', nickname: '脚本回看验收' },
  });
  expect(registered.ok()).toBe(true);
  const auth = await registered.json() as AuthResponse;
  const headers = { Authorization: `Bearer ${auth.token}` };
  const uploaded = await request.post(`${base}/api/assets`, {
    headers,
    multipart: { kind: 'garment', file: { name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: await readFile(path.resolve('../docs/spike/inputs.jpg')) } },
  });
  expect(uploaded.ok()).toBe(true);
  const garment = await uploaded.json() as Asset;
  const created = await request.post(`${base}/api/projects`, {
    headers,
    data: { title: `随时回看脚本 · ${mode}`, brand: '自由创作', brief: '自然通勤，保留浅色衬衫的衣服细节。', garment_asset_ids: [garment.id], mode },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json() as Project;
  const errors: string[] = [];
  const posts: { url: string; body: unknown }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => {
    if (value.method() === 'POST' && value.url().startsWith(`${base}/api/`)) posts.push({ url: value.url(), body: value.postDataJSON() });
  });
  await page.addInitScript(({ token, baseUrl, legalVersion, privacyKey }) => {
    sessionStorage.setItem('outfit.session', token);
    localStorage.setItem('outfit.server', baseUrl);
    localStorage.setItem('outfit.onboarding.v1', 'done');
    localStorage.setItem(privacyKey, legalVersion);
  }, { token: auth.token, baseUrl: base, legalVersion: LEGAL_VERSION, privacyKey: PRIVACY_CONSENT_KEY });
  async function state() {
    const response = await request.get(`${base}/api/projects/${project.id}/state`, { headers });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<ProjectState>;
  }
  async function messages() {
    const response = await request.get(`${base}/api/projects/${project.id}/messages`, { headers });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Message[]>;
  }
  async function send(body: { text?: string; action?: Action }) {
    const response = await request.post(`${base}/api/projects/${project.id}/messages`, { headers, data: body });
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toContain('event: error');
  }
  async function snapshot() {
    const current = await state();
    return {
      script: current.script, versions: current.script_versions,
      cost: current.cost_cny, points: current.cost_points,
      images: current.images.map(image => image.id),
      jobs: current.active_jobs.map(job => job.id).sort(),
      note: current.note, video: current.video,
      messages: (await messages()).map(message => message.id),
    };
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  return { base, project, errors, posts, state, send, snapshot, close, advance: (milliseconds: number) => { now += milliseconds; } };
}

async function readScript(page: Page, script: ScriptData) {
  const entry = page.getByTestId('view-script');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('查看已确认脚本');
  await entry.click();
  const viewer = page.getByTestId('script-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText('已确认脚本');
  await expect(viewer).toContainText(`${script.shots.length} 个镜头`);
  for (const title of script.title_ideas) await expect(viewer).toContainText(title);
  for (const value of Object.values(script.cover)) if (value) await expect(viewer).toContainText(value);
  await expect(viewer.getByTestId(/^script-viewer-shot-/)).toHaveCount(script.shots.length);
  for (const shot of script.shots) {
    const row = viewer.getByTestId(`script-viewer-shot-${shot.id}`);
    for (const value of [shot.scene, shot.pose, shot.camera, shot.styling, shot.caption]) if (value) await expect(row).toContainText(value);
  }
  await expect(viewer).toContainText(`${script.video.duration} 秒短片灵感`);
  await expect(viewer).toContainText(script.video.prompt);
  await expect(viewer.getByTestId('confirm-script')).toHaveCount(0);
  await expect(viewer.getByTestId(/^edit-shot-/)).toHaveCount(0);
  await expect(viewer.getByRole('textbox')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('script-viewer.png'), animations: 'disabled' });
  await page.getByTestId('close-script').click();
  await expect(viewer).not.toBeVisible();
}

test('脚本回看：两步选方向、单镜草稿与确认后生成中、刷新、笔记阶段都能查看', async ({ page, request }) => {
  const context = await setup(page, request, 'guided');
  try {
    await context.send({ text: '帮我找几个拍摄方向。' });
    context.advance(1_000);
    await expect.poll(async () => (await context.state()).active_jobs.length).toBe(0);
    const directions = (await context.state()).directions;
    await page.goto(`/projects/${context.project.id}`);
    await expect(page.getByTestId('view-script')).toHaveCount(0);
    const beforePick = await context.snapshot();
    await page.getByTestId(`direction-${directions[0].id}`).click();
    await expect(page.getByTestId('direction-confirm-bar')).toContainText(directions[0].name);
    await page.getByTestId(`direction-${directions[1].id}`).click();
    await expect(page.getByTestId('direction-confirm-bar')).toContainText(directions[1].name);
    expect(context.posts).toEqual([]);
    expect(await context.snapshot()).toEqual(beforePick);
    expect((await context.state()).chosen_direction_id).toBeFalsy();
    const chosen = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/projects/${context.project.id}/messages`));
    await page.getByTestId('confirm-direction').click();
    expect((await chosen).request().postDataJSON()).toEqual({ action: { type: 'choose_direction', direction_id: directions[1].id, preview_id: directions[1].previews![0].id } });
    await expect(page.getByTestId('confirm-script')).toBeEnabled();
    expect((await context.state()).chosen_direction_id).toBe(directions[1].id);
    await expect(page.getByTestId('view-script')).toHaveCount(0);

    const draft = (await context.state()).script!;
    const postsBeforeDraft = context.posts.length;
    await page.getByTestId(`edit-shot-${draft.shots[1].id}`).click();
    const tools = page.getByTestId(`shot-tools-${draft.shots[1].id}`);
    await expect(tools.getByRole('checkbox', { name: '换个场景', exact: true })).toBeVisible();
    await tools.getByRole('checkbox', { name: '自己说…', exact: true }).click();
    await expect(page.getByTestId('chat-input')).toHaveValue('第 2 镜：');
    expect(context.posts).toHaveLength(postsBeforeDraft);
    expect((await context.state()).script).toEqual(draft);
    await page.getByTestId('chat-input').fill('');

    const confirmed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/projects/${context.project.id}/messages`));
    await page.getByTestId('confirm-script').click();
    expect((await confirmed).request().postDataJSON()).toEqual({ action: { type: 'confirm_script' } });
    const generating = await context.state();
    expect(generating.stage).toBe('images');
    expect(generating.active_jobs.length).toBeGreaterThan(0);
    expect(generating.script).toEqual({ ...draft, status: 'confirmed' });
    const beforeViewing = await context.snapshot();
    const postsBeforeViewing = context.posts.length;
    await readScript(page, generating.script!);
    await readScript(page, generating.script!);
    await page.reload();
    await readScript(page, generating.script!);
    expect(context.posts).toHaveLength(postsBeforeViewing);
    expect(await context.snapshot()).toEqual(beforeViewing);

    await expect.poll(async () => {
      context.advance(20_000);
      const current = await context.state();
      return draft.shots.every(shot => current.images.some(image => image.shot_id === shot.id && image.status === 'succeeded')) && current.active_jobs.length === 0;
    }).toBe(true);
    const completedImages = (await context.state()).images;
    const selectedImages = draft.shots.map(shot => completedImages.filter(image => image.shot_id === shot.id && image.status === 'succeeded').sort((a, b) => b.version - a.version)[0].id);
    await page.reload();
    await expect(page.getByTestId('approve-images')).toBeEnabled();
    await expect(page.locator('button button, [role="button"] [role="button"]')).toHaveCount(0);
    const preview = page.getByTestId(`image-select-${selectedImages[0]}`);
    // 主图固定在第一位，取消选中要用第二镜来验证。
    const selection = page.getByTestId(`image-toggle-${selectedImages[1]}`);
    await expect(selection).toHaveText(/^\d+$/);
    await selection.click();
    await expect(selection).toHaveText('');
    await expect(page.getByTestId('image-viewer')).toHaveCount(0);
    await selection.click();
    await expect(selection).toHaveText(/^\d+$/);
    await expect(page.getByTestId('image-viewer')).toHaveCount(0);
    await preview.click();
    await expect(page.getByTestId('image-viewer')).toBeVisible();
    await page.getByTestId('viewer-close').click();
    await preview.click({ delay: 650 });
    await expect(page.getByTestId('image-menu')).toBeVisible();
    await page.getByRole('button', { name: '取消图片菜单', exact: true }).click();
    await expect(page.getByTestId('image-viewer')).toHaveCount(0);
    await context.send({ action: { type: 'approve_images', image_ids: selectedImages } });
    await page.reload();
    const note = await context.state();
    expect(note.stage).toBe('note');
    expect(note.note?.title).toBeTruthy();
    const beforeNoteViewing = await context.snapshot();
    await readScript(page, generating.script!);
    await readScript(page, generating.script!);
    expect(context.posts).toHaveLength(postsBeforeViewing);
    expect(await context.snapshot()).toEqual(beforeNoteViewing);
    expect(context.errors).toEqual([]);
  } finally { await context.close(); }
});

test('脚本回看：全自动生成中和完成后入口保留，刷新回看不重新生成或扣点', async ({ page, request }) => {
  const context = await setup(page, request, 'auto');
  try {
    await expect.poll(async () => {
      context.advance(250);
      return (await context.state()).stage;
    }).toBe('images');
    const generating = await context.state();
    expect(generating.active_jobs.length).toBeGreaterThan(0);
    await page.goto(`/projects/${context.project.id}`);
    await expect(page.getByTestId('auto-progress')).toBeVisible();
    const beforeViewing = await context.snapshot();
    await readScript(page, generating.script!);
    await readScript(page, generating.script!);
    expect(context.posts).toEqual([]);
    expect(await context.snapshot()).toEqual(beforeViewing);

    context.advance(20_000);
    await expect.poll(async () => {
      context.advance(250);
      return (await context.state()).stage;
    }).toBe('done');
    const complete = await context.state();
    expect(complete.script).toEqual(generating.script);
    expect(complete.video?.status).toBe('succeeded');
    expect(complete.note?.title).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId('confirm-script')).toHaveCount(0);
    await expect(page.getByTestId('approve-images')).toHaveCount(0);
    await expect(page.getByTestId('confirm-video')).toHaveCount(0);
    const beforeCompleteViewing = await context.snapshot();
    await readScript(page, complete.script!);
    await page.reload();
    await readScript(page, complete.script!);
    expect(context.posts).toEqual([]);
    expect(await context.snapshot()).toEqual(beforeCompleteViewing);
    expect(context.errors).toEqual([]);
  } finally { await context.close(); }
});
