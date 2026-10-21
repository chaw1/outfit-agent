import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import type { Asset, AuthResponse, CreateProjectInput, Message, Project, ProjectState } from '../src/api/types';

const shots = path.resolve('screenshots');
const fixture = path.resolve('../docs/spike/inputs.jpg');
const forbidden = /¥|元|费用|花费|价格/;
const automaticControls = '[data-testid="confirm-script"], [data-testid="approve-images"], [data-testid="confirm-video"], [data-testid="retry-video"], [data-testid^="restore-script-"]';
type AutomaticAudit = { controls: string[]; words: string[]; steps: string[]; observer: MutationObserver };
declare global { interface Window { round9Audit?: AutomaticAudit } }

async function pointsOnly(page: Page) {
  expect(await page.locator('body').innerText()).not.toMatch(forbidden);
}

async function screenshot(page: Page, name: string, focus?: Locator) {
  await mkdir(shots, { recursive: true });
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await Promise.all(Array.from(document.images).filter(image => {
      const bounds = image.getBoundingClientRect();
      return bounds.width && bounds.height && bounds.bottom > 0 && bounds.top < innerHeight;
    }).map(image => image.decode().catch(() => undefined)));
  });
  await page.waitForTimeout(350);
  await pointsOnly(page);
  await page.screenshot({ path: path.join(shots, name), animations: 'disabled' });
}

async function beginAutomaticAudit(page: Page) {
  await page.evaluate(selector => {
    const audit: AutomaticAudit = { controls: [], words: [], steps: [], observer: new MutationObserver(() => inspect()) };
    function inspect() {
      for (const element of document.querySelectorAll(selector)) {
        const id = element.getAttribute('data-testid')!;
        if (!audit.controls.includes(id)) audit.controls.push(id);
      }
      const word = document.body.innerText.match(/¥|元|费用|花费|价格/)?.[0];
      if (word && !audit.words.includes(word)) audit.words.push(word);
      const step = document.querySelector('[data-testid="auto-current-step"]')?.textContent;
      if (step && !audit.steps.includes(step)) audit.steps.push(step);
    }
    window.round9Audit = audit;
    audit.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    inspect();
  }, automaticControls);
}

async function endAutomaticAudit(page: Page) {
  const result = await page.evaluate(() => {
    const audit = window.round9Audit!;
    audit.observer.disconnect();
    return { controls: audit.controls, words: audit.words, steps: audit.steps };
  });
  expect(result.controls, 'automatic projects never mount human confirmation controls').toEqual([]);
  expect(result.words, 'all automatic steps show points only').toEqual([]);
  return result;
}

async function setup(page: Page, request: APIRequestContext, label: string) {
  const dataRoot = path.resolve('mock-server/.data/tests');
  await mkdir(dataRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(dataRoot, 'round9-browser-'));
  const { createMockServer } = await import('../mock-server/index.mjs');
  // Real autonomous workers, with pauses long enough for the three-second UI poll.
  const server = await createMockServer({ dataDir, tokenDelayMs: 0, previewDelayMs: 1500, previewStaggerMs: 100, imageDelayMs: 5000, imageStaggerMs: 250, editDelayMs: 1500, videoDelayMs: 5000, runningDelayMs: 100, autoStepDelayMs: 4000, workerIntervalMs: 50 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local mock did not start');
  const base = `http://127.0.0.1:${address.port}`;
  const registered = await request.post(`${base}/api/auth/register`, { data: { username: `round9_${label}_${Date.now()}`, password: 'Local-round9-2026', nickname: '片场验收' } });
  expect(registered.ok()).toBe(true);
  const auth = await registered.json() as AuthResponse;
  const headers = { Authorization: `Bearer ${auth.token}` };
  const uploaded = await request.post(`${base}/api/assets`, { headers, multipart: { kind: 'garment', file: { name: 'round9-shirt.jpg', mimeType: 'image/jpeg', buffer: await readFile(fixture) } } });
  expect(uploaded.ok()).toBe(true);
  const garment = await uploaded.json() as Asset;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ token, baseUrl }) => {
    sessionStorage.setItem('outfit.session', token);
    localStorage.setItem('outfit.server', baseUrl);
    localStorage.setItem('outfit.onboarding.v1', 'done');
  }, { token: auth.token, baseUrl: base });
  const input: CreateProjectInput = { title: '离开也继续的片场', brand: '自由创作', brief: '自然通勤，保留衣服原来的细节。', garment_asset_ids: [garment.id] };
  async function create(overrides: Partial<CreateProjectInput> = {}) {
    const response = await request.post(`${base}/api/projects`, { headers, data: { ...input, ...overrides } });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Project>;
  }
  async function state(id: string) {
    const response = await request.get(`${base}/api/projects/${id}/state`, { headers });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<ProjectState>;
  }
  async function messages(id: string) {
    const response = await request.get(`${base}/api/projects/${id}/messages`, { headers });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Message[]>;
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => (server as Server).close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  return { base, headers, input, garment, errors, create, state, messages, close };
}

test('第九轮：片场入口、两种模式、风格换批与全自动图文视频', async ({ page, request }) => {
  test.setTimeout(180_000);
  const context = await setup(page, request, 'full');
  try {
    const ongoing = await context.create({ title: '等我挑方向的片场' });
    const direction = await request.post(`${context.base}/api/projects/${ongoing.id}/messages`, { headers: context.headers, data: { text: '帮我找几个拍摄方向。' } });
    expect(direction.ok()).toBe(true);
    expect(await direction.text()).not.toContain('event: error');
    await page.goto('/');
    await expect(page.getByTestId('inspiration-wall')).toBeVisible();
    await expect(page.getByTestId(/^inspiration-\d{2}$/)).toHaveCount(10);
    const inspirationSize = await page.getByTestId('inspiration-01').boundingBox();
    expect(inspirationSize).not.toBeNull();
    expect(inspirationSize!.width).toBeGreaterThan(100);
    expect(inspirationSize!.width).toBeLessThan(200);
    expect(inspirationSize!.height).toBeGreaterThan(100);
    expect(inspirationSize!.height).toBeLessThan(350);
    await screenshot(page, '90-studio-inspiration-wall.png', page.getByText('灵感墙', { exact: true }));
    await page.getByTestId('inspiration-01').click();
    await expect(page.getByTestId('inspiration-viewer')).toBeVisible();
    await screenshot(page, '91-inspiration-large-view.png');
    await page.getByRole('button', { name: '关闭灵感大图', exact: true }).click();
    const progress = page.getByTestId(`progress-${ongoing.id}`);
    await expect(progress).toContainText(/方向预览生成中|等你挑个方向/);
    await expect(progress).toContainText('继续');
    await screenshot(page, '92-home-in-progress.png', progress);
    await page.getByRole('button', { name: '拍一组新片', exact: true }).click();
    await expect(page.getByText(/一件衣服，\s*一组大片/)).toBeVisible();
    await expect(page.getByTestId('mode-guided')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('mode-description')).toHaveText('聊灵感、定脚本、挑图改图，每一步你说了算。');
    await expect(page.getByTestId('start-shooting')).toHaveAttribute('aria-label', '开拍，先聊灵感');
    await screenshot(page, '93-new-guided-mode.png', page.getByTestId('mode-guided'));
    await page.getByRole('button', { name: '了解沉浸编导', exact: true }).click();
    await expect(page.getByRole('button', { name: '知道了', exact: true })).toBeVisible();
    await pointsOnly(page);
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await page.getByTestId('mode-auto').click();
    await expect(page.getByTestId('mode-description')).toHaveText('交给我们，全套图文和视频一次出好，中途可以接手。');
    await expect(page.getByTestId('start-shooting')).toHaveAttribute('aria-label', '开拍，全自动 · 约 48 点');
    await page.getByRole('button', { name: '了解一键出片', exact: true }).click();
    await screenshot(page, '94-new-auto-explanation.png');
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    const initialTags = await page.getByTestId(/^style-tag-/).allTextContents();
    expect(initialTags).toHaveLength(8);
    const selected = initialTags[0];
    await expect(page.getByTestId(`style-tag-${selected}`)).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('shuffle-style-tags').click();
    const nextTags = await page.getByTestId(/^style-tag-/).allTextContents();
    expect(nextTags).toHaveLength(8);
    expect(nextTags).not.toEqual(initialTags);
    await expect(page.getByTestId('selected-style-tags')).toContainText(selected);
    const extraTag = nextTags.find(tag => tag !== selected)!;
    await page.getByTestId(`style-tag-${extraTag}`).click();
    await expect(page.getByTestId('selected-style-tags')).toContainText('已选 2/6');
    const brief = '街角自然光，保留这句拍摄原文，不把风格词拼进来。';
    await page.getByLabel('这次想拍什么', { exact: true }).fill(brief);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('upload-garments').click();
    await (await chooser).setFiles(fixture);
    await expect(page.getByRole('button', { name: '移除衣服图 1', exact: true })).toBeVisible();
    await screenshot(page, '95-style-batch-and-estimate.png', page.getByTestId('selected-style-tags'));
    await beginAutomaticAudit(page);
    const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${context.base}/api/projects`);
    await page.getByTestId('start-shooting').click();
    const response = await createdResponse;
    const submitted = response.request().postDataJSON() as CreateProjectInput;
    expect(submitted).toMatchObject({ mode: 'auto', style_tags: [selected, extraTag], brand: '自由创作', title: `自由创作 · ${selected}`, brief });
    expect(submitted.garment_asset_ids).toHaveLength(1);
    const project = await response.json() as Project;
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
    const labels = ['正在找拍摄方向', '正在写拍摄脚本', '正在出图', '正在整理图文', '正在生成视频', '全套已出好'];
    for (const label of labels) {
      await expect(page.getByTestId('auto-current-step')).toHaveText(label, { timeout: 35_000 });
      await expect(page.locator(automaticControls)).toHaveCount(0);
      await pointsOnly(page);
      if (label === '正在写拍摄脚本') await screenshot(page, '96-auto-script-progress.png', page.getByTestId('auto-progress'));
    }
    await expect(page.getByText('这组片全套出好了，图文和视频都在预览里，随时回来看看。', { exact: true })).toBeVisible();
    await expect(page.getByTestId('play-video')).toBeVisible();
    await screenshot(page, '97-auto-finished-note-and-video.png', page.getByTestId('play-video'));
    const audit = await endAutomaticAudit(page);
    expect(audit.steps).toEqual(labels);
    const done = await context.state(project.id);
    expect(done).toMatchObject({ mode: 'auto', stage: 'done', style_tags: [selected, extraTag], auto: { active: false, step: 'done' }, pending_action: null });
    const history = await context.messages(project.id);
    expect(history.every(message => message.role === 'assistant')).toBe(true);
    expect(history.filter(message => message.text).length).toBeGreaterThanOrEqual(6);
    for (const message of history.filter(message => message.text)) await expect(page.getByTestId(`message-${message.id}`)).toBeVisible();
    await page.getByTestId('preview-note').click();
    await expect(page.getByTestId('note-title')).toBeVisible();
    await pointsOnly(page);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByTestId('recent-completions')).toContainText(project.title);
    await screenshot(page, '98-home-just-finished.png', page.getByTestId('recent-completions'));
    await page.getByRole('button', { name: `查看刚刚出好 ${project.title}`, exact: true }).click();
    await expect(page.getByTestId('auto-current-step')).toHaveText('全套已出好');
    await pointsOnly(page);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByText('我的点数', { exact: true })).toBeVisible();
    const meResponse = await request.get(`${context.base}/api/me`, { headers: context.headers });
    expect(meResponse.ok()).toBe(true);
    const freshUser = await meResponse.json() as AuthResponse['user'];
    expect(freshUser.today_cost_points).toBeGreaterThan(0);
    await expect(page.getByTestId('settings-used-points')).toHaveText(`今天用了 ${freshUser.today_cost_points} 点`);
    await pointsOnly(page);
    expect(context.errors).toEqual([]);
    await writeFile(path.join(shots, 'round9-evidence.json'), JSON.stringify({ projectId: project.id, submitted, steps: audit.steps, automaticControls: audit.controls, proactiveMessages: history.length, pointsOnly: true, recentCompletion: true, pageErrors: context.errors }, null, 2));
  } finally { await context.close(); }
});

test('第九轮：引导、登录、注册入口、设置和关于都只显示点数措辞', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('outfit.server', 'http://localhost:19301'));
  await page.goto('/');
  const titles = ['一件衣服，一组大片', '一键出片，或者一步步来', '正式出图和视频会扣点，由你确认'];
  for (let index = 0; index < titles.length; index += 1) {
    await expect(page.getByTestId(`onboarding-${index + 1}`)).toContainText(titles[index]);
    await pointsOnly(page);
    await page.getByRole('button', { name: index === 2 ? '进入片场' : '下一步', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: '登录，继续创作', exact: true })).toBeVisible();
  await pointsOnly(page);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page.getByLabel('怎么称呼你', { exact: true })).toBeVisible();
  await pointsOnly(page);
  await page.getByRole('button', { name: '服务器设置', exact: true }).click();
  await expect(page.getByLabel('服务器地址', { exact: true })).toBeVisible();
  await pointsOnly(page);
  await page.getByRole('button', { name: '关于衣序与隐私', exact: true }).click();
  await expect(page.getByTestId('app-version')).toBeVisible();
  await pointsOnly(page);
});

test('第九轮：脚本接手恢复确认，出图接手保留已在跑的任务', async ({ page, request }) => {
  test.setTimeout(150_000);
  const context = await setup(page, request, 'takeover');
  try {
    const project = await context.create({ mode: 'auto', title: '脚本时由我接手' });
    await page.goto(`/projects/${project.id}`);
    await beginAutomaticAudit(page);
    await expect(page.getByTestId('auto-current-step')).toHaveText('正在写拍摄脚本', { timeout: 30_000 });
    const audit = await endAutomaticAudit(page);
    const takeoverResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/projects/${project.id}/mode`));
    await page.getByTestId('takeover-auto').click();
    const takeover = await takeoverResponse;
    expect(takeover.request().postDataJSON()).toEqual({ mode: 'guided' });
    expect(await takeover.json()).toMatchObject({ mode: 'guided', auto: { active: false }, pending_action: { type: 'confirm_script' } });
    await expect(page.getByTestId('confirm-script')).toBeEnabled();
    await expect(page.getByTestId('takeover-auto')).toHaveCount(0);
    await screenshot(page, '99-takeover-script-confirmation.png', page.getByTestId('confirm-script'));
    expect((await context.state(project.id)).script?.status).toBe('draft');
    await pointsOnly(page);

    const running = await context.create({ mode: 'auto', title: '出图时由我接手' });
    await page.goto(`/projects/${running.id}`);
    await beginAutomaticAudit(page);
    await expect(page.getByTestId('auto-current-step')).toHaveText('正在出图', { timeout: 35_000 });
    const before = await context.state(running.id);
    expect(before.active_jobs.length).toBeGreaterThan(0);
    const jobIds = before.active_jobs.map(job => job.id);
    await endAutomaticAudit(page);
    await page.getByTestId('takeover-auto').click();
    await expect.poll(async () => (await context.state(running.id)).mode).toBe('guided');
    for (const jobId of jobIds) {
      const result = await request.get(`${context.base}/api/jobs/${jobId}`, { headers: context.headers });
      expect(result.ok()).toBe(true);
      expect((await result.json()).status).not.toBe('failed');
    }
    await expect(page.getByTestId('approve-images')).toBeEnabled({ timeout: 35_000 });
    const finished = await context.state(running.id);
    expect(finished.mode).toBe('guided');
    expect(finished.stage).toBe('images');
    expect(finished.images.filter(image => image.version === 1).every(image => image.status === 'succeeded')).toBe(true);
    expect(finished.note).toBeUndefined();
    await pointsOnly(page);
    expect(audit.controls).toEqual([]);
    expect(context.errors).toEqual([]);
  } finally { await context.close(); }
});
