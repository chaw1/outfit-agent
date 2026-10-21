import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, AuthResponse, Project, ProjectState } from '../src/api/types';

const shots = path.resolve(process.env.E2E_SCREENSHOTS_DIR || 'screenshots/polish');
const apiBase = process.env.E2E_API_BASE || 'http://localhost:19301/api';
const fontScale = 1.15;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// RN Web uses fixed pixel text styles. Scale text-bearing DOM nodes rather than CSS zoom,
// which would enlarge the viewport and would not exercise text wrapping in the same layout.
async function enlargeWebText(page: Page) {
  return page.evaluate(factor => {
    let adjusted = 0;
    for (const node of document.querySelectorAll<HTMLElement>('body *')) {
      if (['SCRIPT', 'STYLE', 'SVG', 'PATH'].includes(node.tagName) || !node.getBoundingClientRect().width) continue;
      const ownText = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent ?? '').join('');
      if (!ownText.trim() && !['INPUT', 'TEXTAREA'].includes(node.tagName)) continue;
      if (/[\uE000-\uF8FF]/u.test(ownText)) continue;
      const computed = getComputedStyle(node);
      if (/ionicons/i.test(computed.fontFamily)) continue;
      const base = Number(node.dataset.polishFont || parseFloat(computed.fontSize));
      if (!Number.isFinite(base) || base <= 0) continue;
      node.dataset.polishFont = String(base);
      node.style.setProperty('font-size', `${base * factor}px`, 'important');
      const line = Number(node.dataset.polishLine || parseFloat(computed.lineHeight));
      if (Number.isFinite(line) && line > 0) {
        node.dataset.polishLine = String(line);
        node.style.setProperty('line-height', `${line * factor}px`, 'important');
      }
      adjusted += 1;
    }
    return { factor, adjustedTextNodes: adjusted };
  }, fontScale);
}

async function inspectVisibleControls(page: Page) {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="checkbox"]')).flatMap(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0 || node.closest('[aria-hidden="true"], [inert]')) return [];
      let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const bounds = parent.getBoundingClientRect();
        const parentStyle = getComputedStyle(parent);
        if (parentStyle.visibility === 'hidden' || Number(parentStyle.opacity) === 0) return [];
        if (/hidden|clip|auto|scroll/.test(parentStyle.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/hidden|clip|auto|scroll/.test(parentStyle.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      if (right <= left || bottom <= top) return [];
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!hit || (hit !== node && !node.contains(hit))) return [];
      const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
      const name = (node.getAttribute('aria-label') || labelledBy.trim() || node.getAttribute('title') || node.textContent || '').replace(/[\uE000-\uF8FF]/gu, '').trim();
      return [{ role: node.getAttribute('role') || 'button', name, testID: node.dataset.testid || null, width: Number(rect.width.toFixed(2)), height: Number(rect.height.toFixed(2)), disabled: node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('disabled') }];
    });
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), controls };
  });
}

test('视觉打磨：骨架、图片恢复和 115% Web 字体可访问性证据', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir(shots, { recursive: true });
  const pageErrors: string[] = [];
  const animationErrors: string[] = [];
  const samples: unknown[] = [];
  const reachableActions: unknown[] = [];
  const screenshots: string[] = [];
  const releases: (() => void)[] = [];
  let projectId = '';
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /reanimated|worklet/i.test(message.text())) animationErrors.push(message.text()); });

  async function capture(file: string, label: string, focus?: Locator) {
    const scaling = await enlargeWebText(page);
    if (focus) await focus.scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      }).map(image => image.decode().catch(() => undefined)));
    });
    await page.waitForTimeout(350);
    const audit = await inspectVisibleControls(page);
    const definiteViolations = audit.controls.filter(control => !control.name || control.width < 43.5 || control.height < 43.5);
    samples.push({ label, file, scaling, ...audit, definiteViolations });
    await page.screenshot({ path: path.join(shots, file), animations: 'disabled' });
    screenshots.push(file);
    expect(audit.horizontalOverflow, `${label}: document 横向溢出`).toBeLessThanOrEqual(1);
    expect(definiteViolations, `${label}: 可见且未被遮挡的控件点击区或名称`).toEqual([]);
  }

  async function reachable(label: string, locator: Locator) {
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ trial: true });
    const bounds = await locator.boundingBox();
    expect(bounds, `${label}: 按钮应可滚动到达`).not.toBeNull();
    if (!bounds) return;
    reachableActions.push({ label, reachable: true, bounds });
    expect(bounds.x).toBeGreaterThanOrEqual(-1);
    expect(bounds.y).toBeGreaterThanOrEqual(-1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
  }

  try {
    const registered = await request.post(`${apiBase}/auth/register`, { data: { username: `polish_${Date.now()}`, password: 'Local-visual-2026', nickname: '视觉验收' } });
    expect(registered.ok()).toBe(true);
    const auth = await registered.json() as AuthResponse;
    const headers = { Authorization: `Bearer ${auth.token}` };
    const fixture = await readFile(path.resolve('../docs/spike/inputs.jpg'));
    async function upload(kind: 'garment' | 'model'): Promise<Asset> {
      const response = await request.post(`${apiBase}/assets`, { headers, multipart: { kind, file: { name: `polish-${kind}.jpg`, mimeType: 'image/jpeg', buffer: fixture } } });
      expect(response.ok()).toBe(true);
      return response.json();
    }
    const garment = await upload('garment');
    const model = await upload('model');
    const profile = await request.patch(`${apiBase}/me`, { headers, data: { profile: { model_asset_ids: [model.id], height_cm: 168, body_notes: '肩略宽，想突出自然腰线', style_notes: '喜欢松弛感、日常通勤，不穿高跟鞋' } } });
    expect(profile.ok()).toBe(true);
    const created = await request.post(`${apiBase}/projects`, { headers, data: { title: '秋日松弛穿搭视觉验收', brand: 'LOCAL STUDIO', brief: '用自然面料与轻松穿搭记录日常，突出衬衫细节。', garment_asset_ids: [garment.id] } });
    expect(created.ok()).toBe(true);
    const project = await created.json() as Project;
    projectId = project.id;
    const initial = await request.get(`${apiBase}/projects/${project.id}/state`, { headers });
    expect(initial.ok()).toBe(true);
    const originalState = await initial.json() as ProjectState;
    await page.addInitScript(({ token, base }) => { sessionStorage.setItem('outfit.session', token); localStorage.setItem('outfit.server', base); localStorage.setItem('outfit.privacy-consent', '2026-10-21'); }, { token: auth.token, base: process.env.E2E_MOCK_BASE || 'http://localhost:19301' });

    const homeGate = gate(); releases.push(homeGate.release);
    await page.route(`${apiBase}/projects`, async route => { if (route.request().method() === 'GET') await homeGate.promise; await route.continue(); });
    await page.goto('/');
    for (let index = 1; index <= 3; index += 1) {
      await expect(page.getByTestId(`onboarding-${index}`)).toBeVisible();
      await capture(`${59 + index}-onboarding-${index}-font115.png`, `onboarding-${index}`);
      const next = page.getByRole('button', { name: index === 3 ? '进入片场' : '下一步', exact: true });
      await reachable(`onboarding-${index} 下一步`, next);
      await next.click();
    }
    await expect(page.getByText('视觉验收的片场', { exact: true })).toBeVisible();
    const homeSkeleton = page.getByRole('progressbar', { name: '正在加载内容', exact: true });
    await expect(homeSkeleton).toBeVisible();
    await capture('63-home-skeleton-font115.png', 'home-skeleton', homeSkeleton);
    homeGate.release();
    // Keep the resolved gate registered; unroute can race the suspended handler's continue.
    await expect(page.getByRole('button', { name: `打开这组片 ${project.title}`, exact: true })).toBeVisible();
    await capture('64-home-font115.png', 'home', page.getByText('视觉验收的片场', { exact: true }));
    await reachable('首页拍一组新片', page.getByRole('button', { name: '拍一组新片', exact: true }));

    await page.goto('/projects/new');
    await page.getByLabel('项目名称', { exact: true }).fill('十五个百分点字体放大的秋日这组片');
    await page.getByLabel('品牌', { exact: true }).fill('LOCAL STUDIO');
    await page.getByLabel('这次想拍什么', { exact: true }).fill('自然面料、松弛通勤与周末散步，希望文案像朋友分享。');
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('upload-garments').click();
    await (await chooser).setFiles({ name: 'local-shirt.jpg', mimeType: 'image/jpeg', buffer: fixture });
    await expect(page.getByRole('button', { name: '移除衣服图 1', exact: true })).toBeVisible();
    await capture('65-new-project-font115.png', 'new-project', page.getByLabel('项目名称', { exact: true }));
    await reachable('新建开拍，先聊灵感', page.getByRole('button', { name: '开拍，先聊灵感', exact: true }));
    await capture('66-new-project-submit-font115.png', 'new-project-submit');

    await page.goto('/settings');
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('视觉验收');
    await capture('67-settings-profile-font115.png', 'settings-profile');
    await reachable('设置保存我的形象', page.getByRole('button', { name: '保存我的形象', exact: true }));
    await reachable('设置保存服务器地址', page.getByRole('button', { name: '保存服务器地址', exact: true }));
    await capture('68-settings-service-font115.png', 'settings-service');

    let stateGate: ReturnType<typeof gate> | undefined = gate();
    let historyGate: ReturnType<typeof gate> | undefined = gate();
    releases.push(stateGate.release, historyGate.release);
    type PreviewMode = 'real' | 'empty' | 'missing-image' | 'broken-image' | 'ready';
    let mode: PreviewMode = 'real';
    const previewImageId = 'polish-preview-image';
    const brokenUrl = `${garment.url}${garment.url.includes('?') ? '&' : '?'}polish_broken=1`;
    function previewState(): ProjectState {
      if (mode === 'empty') return { ...originalState, images: [], note: undefined, active_jobs: [] };
      return { ...originalState, stage: 'note', active_jobs: [], images: [{ id: previewImageId, shot_id: 'polish-shot', status: mode === 'missing-image' ? 'queued' : 'succeeded', version: 1, ...(mode === 'missing-image' ? {} : { url: mode === 'broken-image' ? brokenUrl : garment.url }) }], note: { title: '把秋天穿成一杯燕麦拿铁', body: '把日常穿得轻松一点，灵感就藏在每一次出门里。\n\n自然面料、干净线条，配上熟悉的牛仔裤。\n\n这一次，把自己的风格放在最前面。', tags: ['秋日穿搭', '松弛感', '日常通勤'], image_ids: [previewImageId], cost_cny: 0, ai_label: '本篇含 AI 生成内容，发布时请勾选平台的 AI 内容声明。' } };
    }
    const stateUrl = `${apiBase}/projects/${project.id}/state`;
    const historyUrl = `${apiBase}/projects/${project.id}/messages`;
    await page.route(stateUrl, async route => { if (route.request().method() !== 'GET') return route.continue(); const pending = stateGate; if (pending) await pending.promise; if (mode === 'real') await route.continue(); else await route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: previewState() }); });
    await page.route(historyUrl, async route => { const pending = historyGate; if (pending && route.request().method() === 'GET') await pending.promise; await route.continue(); });
    await page.goto(`/projects/${project.id}`);
    const workspaceSkeleton = page.getByRole('progressbar', { name: '正在加载内容', exact: true });
    await expect(workspaceSkeleton).toBeVisible();
    await capture('69-workspace-skeleton-font115.png', 'workspace-skeleton', workspaceSkeleton);
    stateGate.release(); historyGate.release(); stateGate = undefined; historyGate = undefined;
    await expect(page.getByTestId('direction-direction_city')).toBeVisible();
    await page.getByTestId('chat-input').fill('想让风格再松弛一点，面料细节保持自然。');
    await expect(page.getByTestId('send-message')).toBeEnabled();
    await capture('70-workspace-font115.png', 'workspace', page.getByTestId('direction-direction_city'));
    await reachable('编导间发送消息', page.getByTestId('send-message'));

    mode = 'empty'; stateGate = gate(); historyGate = gate(); releases.push(stateGate.release, historyGate.release);
    await page.goto(`/preview/${project.id}`);
    const noteSkeleton = page.getByRole('progressbar', { name: '正在加载内容', exact: true });
    await expect(noteSkeleton).toBeVisible();
    await expect.poll(() => noteSkeleton.evaluate(element => element.firstElementChild?.getBoundingClientRect().height ?? 0)).toBeGreaterThan(400);
    await capture('71-preview-skeleton-font115.png', 'preview-skeleton', noteSkeleton);
    stateGate.release(); historyGate.release(); stateGate = undefined; historyGate = undefined;
    await expect(page.getByText('笔记还在酝酿中', { exact: true })).toBeVisible();
    await capture('72-preview-empty-font115.png', 'preview-empty');
    await reachable('无笔记返回编导间', page.getByRole('button', { name: '返回编导间', exact: true }));

    mode = 'missing-image';
    await page.reload();
    await expect(page.getByText('图片还在路上', { exact: true })).toBeVisible();
    await capture('73-preview-no-image-font115.png', 'preview-no-image');

    await page.route('**/media/**', async route => {
      if (new URL(route.request().url()).searchParams.has('polish_broken')) await route.fulfill({ status: 503, contentType: 'image/jpeg', headers: { 'Cache-Control': 'no-store' }, body: '' });
      else await route.continue();
    });
    mode = 'broken-image';
    await page.reload();
    const retryImage = page.getByTestId(`retry-preview-${previewImageId}`);
    await expect(retryImage).toBeVisible();
    await capture('74-preview-image-error-font115.png', 'preview-image-error');
    await reachable('预览重新加载图片', retryImage);
    mode = 'ready';
    await retryImage.click();
    const recoveredImage = page.getByTestId(`preview-image-${previewImageId}`);
    await expect(recoveredImage).toBeVisible();
    await expect.poll(() => recoveredImage.evaluate(element => {
      const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
      return !!image?.complete && image.naturalWidth > 0;
    })).toBe(true);
    await capture('75-preview-image-recovered-font115.png', 'preview-image-recovered');
    await capture('76-preview-reading-font115.png', 'preview-reading', page.getByTestId('note-body'));
    await reachable('预览 AI 声明确认', page.getByTestId('publish-ai-confirm'));
    await expect(page.getByTestId('publish-ai-confirm')).toHaveAttribute('aria-checked', 'true');
    await reachable('预览准备发布（仅检查可达）', page.getByTestId('prepare-publish'));
    await capture('77-preview-publish-font115.png', 'preview-publish');
    expect(pageErrors).toEqual([]);
    expect(animationErrors).toEqual([]);
  } finally {
    for (const release of releases) release();
    await writeFile(path.join(shots, 'polish-evidence.json'), JSON.stringify({ completedAt: new Date().toISOString(), projectId, viewport: { width: 390, height: 844 }, fontScale, screenshots, samples, reachableActions, pageErrors, animationErrors, limitations: ['字体检查是 RN Web DOM 字号和行高放大 15% 的代理，不等同于 iOS / Android 原生 Dynamic Type。', '截图为 390×844 无头浏览器，不代表真机刘海、系统键盘和动画帧率验收。', '按钮证据只覆盖截图当下可见且中心未被遮挡的 button / checkbox；滚动到达的重要操作另列。', '无笔记、无图和失败图片由浏览器响应拦截构造，全部使用现有 ProjectState 字段；图片恢复复用本地上传资产。', '未执行发布、系统分享、保存媒体或通知；未访问线上服务。'] }, null, 2));
  }
});
