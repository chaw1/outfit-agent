import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Action, Asset, AuthResponse, Message, Project, ProjectState } from '../src/api/types';
import { LEGAL_VERSION, PRIVACY_CONSENT_KEY } from '../src/lib/legalConsent';

const unreadBorder = 'rgb(255, 36, 66)'; // studio.accent
const readBorder = 'rgb(53, 55, 61)'; // studio.line

async function setup(page: Page, request: APIRequestContext) {
  const dataDir = test.info().outputPath('mock-data');
  await mkdir(dataDir, { recursive: true });
  let now = Date.now();
  const { createMockServer } = await import('../mock-server/index.mjs');
  // Freeze the worker clock until the browser has observed each pending batch.
  const server = await createMockServer({
    dataDir, clock: () => now, tokenDelayMs: 0, runningDelayMs: 0,
    previewDelayMs: 10, previewStaggerMs: 0, imageDelayMs: 60_000,
    imageStaggerMs: 0, editDelayMs: 60_000, workerIntervalMs: 10,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地假服务未启动');
  const base = `http://127.0.0.1:${address.port}`;
  const registered = await request.post(`${base}/api/auth/register`, {
    data: { username: `completion_${now}`, password: 'Local-completion-2026', nickname: '完成提醒验收' },
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
    data: { title: '新片看过以后', brand: '自由创作', brief: '自然通勤，保留浅色衬衫的细节。', garment_asset_ids: [garment.id], mode: 'guided' },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json() as Project;
  const errors: string[] = [];
  const browserPosts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => {
    if (value.method() === 'POST' && value.url().startsWith(`${base}/api/`)) browserPosts.push(value.url());
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
  async function send(body: { text?: string; action?: Action }) {
    const response = await request.post(`${base}/api/projects/${project.id}/messages`, { headers, data: body });
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toContain('event: error');
  }
  async function snapshot() {
    const current = await state();
    const response = await request.get(`${base}/api/projects/${project.id}/messages`, { headers });
    expect(response.ok()).toBe(true);
    const messages = await response.json() as Message[];
    return {
      images: current.images, jobs: current.active_jobs, cost: current.cost_cny,
      points: current.cost_points, messages: messages.map(message => message.id),
    };
  }
  async function finishJobs() {
    await expect.poll(async () => {
      now += 70_000;
      const current = await state();
      return current.active_jobs.length === 0 && current.images.every(image => image.status === 'succeeded');
    }).toBe(true);
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  return { base, project, errors, browserPosts, state, send, snapshot, finishJobs, close, advance: (milliseconds: number) => { now += milliseconds; } };
}

test('刚刚出好：新结果红框，看过恢复普通边框，同项目新版本再次高亮', async ({ page, request }) => {
  const context = await setup(page, request);
  try {
    await context.send({ text: '帮我找几个拍摄方向。' });
    await context.send({ action: { type: 'choose_direction', direction_id: (await context.state()).directions[0].id } });
    await expect.poll(async () => {
      context.advance(100);
      return (await context.state()).active_jobs.length;
    }).toBe(0);
    await context.send({ action: { type: 'confirm_script' } });
    const pending = await context.state();
    expect(pending.active_jobs.length).toBeGreaterThan(0);
    const initialJobs = new Set(pending.active_jobs.map(job => `${context.base}/api/jobs/${job.id}`));
    const observedFirstBatch = page.waitForRequest(value => value.method() === 'GET' && initialJobs.has(value.url()));
    await page.goto(`/projects/${context.project.id}`);
    await expect(page.getByTestId('view-script').filter({ visible: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('button', { name: '拍一组新片', exact: true })).toBeVisible();
    await observedFirstBatch;
    await context.finishJobs();

    const section = page.getByTestId('recent-completions').filter({ visible: true });
    const recent = section.getByTestId(`recent-completion-${context.project.id}`);
    await expect(recent).toBeVisible();
    await expect(recent).toContainText(context.project.title);
    await expect(recent).toHaveCSS('border-top-color', unreadBorder);
    await page.screenshot({ path: test.info().outputPath('first-result-unread.png'), animations: 'disabled' });
    const beforeViewing = await context.snapshot();
    const dismiss = page.getByRole('button', { name: '关闭生成提示', exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    await recent.click();
    await expect(page.getByTestId('view-script').filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId('chat-input').filter({ visible: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(recent).toBeVisible();
    await expect(recent).toHaveCSS('border-top-color', readBorder);
    await expect(section.getByTestId(/^recent-completion-/)).toHaveCount(1);
    expect(await context.snapshot()).toEqual(beforeViewing);
    expect(context.browserPosts).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('first-result-read.png'), animations: 'disabled' });

    const original = (await context.state()).images.find(image => image.status === 'succeeded')!;
    await context.send({ action: { type: 'edit_image', image_id: original.id, instruction: '背景换成阳光下的街角。' } });
    const editing = await context.state();
    const editJob = editing.active_jobs.find(job => job.kind === 'edit');
    expect(editJob).toBeTruthy();
    const observedEdit = page.waitForRequest(value => value.method() === 'GET' && value.url() === `${context.base}/api/jobs/${editJob!.id}`);
    // Re-enter through the existing card so the workspace discovers the API-created job.
    await recent.click();
    await expect(page.getByTestId('view-script').filter({ visible: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(recent).toHaveCSS('border-top-color', readBorder);
    await observedEdit;
    await context.finishJobs();
    await expect(recent).toContainText('改图已完成，新版本可以查看了。');
    await expect(recent).toHaveCSS('border-top-color', unreadBorder);
    await expect(section.getByTestId(/^recent-completion-/)).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('new-version-unread.png'), animations: 'disabled' });

    const beforeSecondViewing = await context.snapshot();
    if (await dismiss.isVisible()) await dismiss.click();
    await recent.click();
    await expect(page.getByTestId('view-script').filter({ visible: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(recent).toHaveCSS('border-top-color', readBorder);
    expect(await context.snapshot()).toEqual(beforeSecondViewing);
    expect(context.browserPosts).toEqual([]);
    expect(context.errors).toEqual([]);
  } finally { await context.close(); }
});
