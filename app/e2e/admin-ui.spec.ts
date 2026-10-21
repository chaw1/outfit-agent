import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:19533';
const adminRoot = path.resolve(__dirname, '../../server/app/admin_static');
const pages = ['总览', '用量统计', '模型与配额', '任务队列', '用户管理'];
const stamp = '2026-10-21T10:00:00Z';

async function openAdmin(page: Page) {
  const models = { text: 'deepseek-flash', vision: 'qwen3-vl-plus', image: 'doubao-seedream-4-5-251128', video: 'wan2.6-i2v-flash' };
  const settings = {
    models,
    tiers: { free: { daily_budget_cny: 12, models: Object.values(models) }, pro: { daily_budget_cny: 120, models: Object.values(models) } },
    global_daily_budget_cny: 1200,
    candidates: Object.fromEntries(Object.entries(models).map(([kind, model]) => [kind, [model]])),
  };
  const users = [
    { id: 'creator-1', username: 'summer_studio', nickname: '夏日衣橱', created_at: stamp, project_count: 12, cost_cny: 32.68, tier: 'pro', disabled: false, deleted_at: null },
    { id: 'creator-2', username: 'deleted-local', nickname: '已注销用户', created_at: stamp, project_count: 0, cost_cny: 4.12, tier: 'free', disabled: true, deleted_at: stamp },
  ];
  const jobs = [{ id: 'job-1', project_id: 'project-1', project_title: '一件白衬衫的周末', user_id: 'creator-1', username: 'summer_studio', kind: 'image', status: 'failed', attempts: 1, error: '生成服务暂时繁忙，原图和修改要求已保留。', duration_ms: 4200, created_at: stamp, updated_at: stamp, cancelled: false, photo_prompt: '自然光咖啡馆。\n保留白色棉质衬衫的面料纹理。' }];
  const usage = { rows: Object.values(models).map((name, index) => ({ key: name, label: name, calls: 12 * (index + 1), duration_ms: 1800 * (index + 1), cost_cny: 3.42 * (index + 1) })) };
  const overview = {
    users: 24, projects: 86, today: { calls: 38, cost_cny: 12.36 }, total: { calls: 627, cost_cny: 218.57 }, requests_24h: 1843, errors_24h: 6,
    stages: [{ stage: 'images', count: 18 }, { stage: 'done', count: 27 }],
    jobs: { queued: 2, running: 3, succeeded: 278, failed: 6 }, success_rate: 0.9789,
    trend: Array.from({ length: 7 }, (_, index) => ({ day: `2026-10-${15 + index}`, calls: 21 + index * 4, cost_cny: 5.2 + index * 1.4 })),
    by_model: usage.rows,
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/admin') return route.fulfill({ contentType: 'text/html', body: readFileSync(path.join(adminRoot, 'index.html'), 'utf8') });
    if (url.pathname === '/admin/tokens.css') return route.fulfill({ contentType: 'text/css', body: readFileSync(path.join(adminRoot, 'tokens.css'), 'utf8') });
    if (url.pathname === '/api/admin/login') return route.fulfill({ json: { token: 'local-ui-fixture', expires_in: 28800 } });
    if (url.pathname === '/api/admin/settings') {
      if (route.request().method() === 'PUT') Object.assign(settings, route.request().postDataJSON());
      return route.fulfill({ json: settings });
    }
    const data = { '/api/admin/overview': overview, '/api/admin/users': users, '/api/admin/jobs': jobs, '/api/admin/usage': usage }[url.pathname];
    return data ? route.fulfill({ json: data }) : route.abort();
  });
  await page.goto(`${origin}/admin`);
  await page.getByLabel('管理口令', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '进入管理台' }).click();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
}

async function navigate(page: Page, name: string) {
  await page.locator('nav').getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

test('管理端：离开任务页再返回仍自动刷新，已注销用户只读', async ({ page }) => {
  await page.clock.install();
  await openAdmin(page);
  await navigate(page, '任务队列');
  await page.locator('#job-auto').check();
  const firstRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/jobs');
  await page.clock.runFor(10_010);
  await firstRefresh;
  await expect(page.locator('#job-auto')).toBeChecked();
  await navigate(page, '用户管理');
  const deleted = page.locator('.user-card').filter({ hasText: 'deleted-local' });
  await expect(deleted.getByText('账号已注销，历史用量仅供查看。')).toBeVisible();
  await expect(deleted.locator('button,select')).toHaveCount(0);
  await navigate(page, '任务队列');
  await expect(page.locator('#job-auto')).toBeChecked();
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/jobs');
  await page.clock.runFor(10_010);
  await refresh;
  await expect(page.locator('#job-auto')).toBeChecked();
});

test('管理端：设置草稿跨页和失败后保留，保存响应不抢回已离开的页面', async ({ page }) => {
  await openAdmin(page);
  await navigate(page, '模型与配额');
  await page.locator('#budget-free').fill('36');
  await expect(page.locator('#settings-status')).toContainText('未保存');
  await navigate(page, '用户管理');
  await navigate(page, '模型与配额');
  await expect(page.locator('#budget-free')).toHaveValue('36');
  const settingsPath = '**/api/admin/settings';
  await page.route(settingsPath, route => route.request().method() === 'PUT' ? route.fulfill({ status: 422, json: { error: { message: '本地验证：预算不合法' } } }) : route.fallback());
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('alert')).toContainText('预算不合法');
  await expect(page.locator('#budget-free')).toHaveValue('36');
  await expect(page.locator('#budget-free')).toBeEnabled();
  await page.unroute(settingsPath);

  let release!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  await page.route(settingsPath, async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    started();
    await new Promise<void>(resolve => { release = resolve; });
    return route.fulfill({ json: route.request().postDataJSON() });
  });
  await page.getByRole('button', { name: '保存设置' }).click();
  await saving;
  await expect(page.locator('#budget-free')).toBeDisabled();
  await navigate(page, '用户管理');
  const saved = page.waitForResponse(response => response.request().method() === 'PUT');
  release();
  await saved;
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#users$/);
});

for (const width of [1440, 390, 320]) {
  test(`管理端：${width}px 五页无横向溢出，控件至少 44px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openAdmin(page);
    for (const name of pages) {
      await navigate(page, name);
      const size = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        shortControls: [...document.querySelectorAll('button,input:not([type=checkbox]),select')]
          .filter(node => node.getBoundingClientRect().height > 0 && node.getBoundingClientRect().height < 43.5)
          .map(node => node.id || node.textContent),
        background: getComputedStyle(document.body).backgroundColor,
        columns: document.querySelector('.kpi-grid') ? getComputedStyle(document.querySelector('.kpi-grid')!).gridTemplateColumns.split(' ').length : undefined,
      }));
      expect(size.scrollWidth, `${name} 横向溢出`).toBeLessThanOrEqual(width);
      expect(size.shortControls, `${name} 控件点击区域不足`).toEqual([]);
      expect(size.background).toBe('rgb(252, 250, 247)');
      if (name === '总览') expect(size.columns).toBe(width === 1440 ? 3 : 2);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}
