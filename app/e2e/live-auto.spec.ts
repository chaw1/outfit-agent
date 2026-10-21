import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { expect, test, type Request } from '@playwright/test';
import sharp from 'sharp';
import type { AuthResponse, Project, ProjectState } from '../src/api/types';
import { normalizeLiveBase, performLiveOnce, sanitizeLiveEvidence, saveLiveCheckpoint, selectLiveRun, type LiveCheckpoint } from './live-support';

const checkpointFile = path.join(homedir(), 'Secrets', 'outfit-agent', 'live-auto-checkpoint.json');
const directory = path.resolve('screenshots-live/auto');
const requiredSteps = ['directions', 'script', 'images', 'note', 'video', 'done'] as const;

// 线上账号只通过下方带遮罩的截图留证。
test.use({ screenshot: 'off', video: 'off' });

test('真实服务一键出片：注册、开拍、自动推进到全套完成（断点续跑）', async ({ page }) => {
  test.skip(!process.env.LIVE_API_BASE, '只有显式设置 LIVE_API_BASE 才运行；不会使用 App 默认地址或旧凭证。');
  test.setTimeout(10 * 60_000);
  const deadline = Date.now() + 10 * 60_000;
  const base = normalizeLiveBase(process.env.LIVE_API_BASE!);
  let previous: LiveCheckpoint | undefined;
  try { previous = JSON.parse(await readFile(checkpointFile, 'utf8')) as LiveCheckpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const fresh = process.env.LIVE_AUTO_NEW_RUN === '1';
  const checkpoint = selectLiveRun(previous, base, fresh);
  if (!previous || fresh) checkpoint.projectTitle = `一键出片验收 ${Date.now().toString(36)}`;
  await mkdir(directory, { recursive: true });
  let saving = Promise.resolve();
  const persist = () => { saving = saving.then(() => saveLiveCheckpoint(checkpoint, checkpointFile)); return saving; };
  await persist();
  const errors: string[] = [];
  const observed = new Set((checkpoint.data.observedSteps as string[] | undefined) ?? []);
  let state: ProjectState | undefined;
  page.on('pageerror', error => errors.push(error.message));
  async function shot(name: string) {
    await page.screenshot({ path: path.join(directory, `run-${checkpoint.run}-${name}.png`), animations: 'disabled', mask: [page.getByLabel('用户名', { exact: true }), page.getByLabel('密码', { exact: true })] });
  }
  async function evidence() {
    checkpoint.data.observedSteps = [...observed];
    await persist();
    await writeFile(path.join(directory, `run-${checkpoint.run}-evidence.json`), `${JSON.stringify(sanitizeLiveEvidence({
      base, projectId: checkpoint.projectId, startedAt: checkpoint.startedAt, completedAt: checkpoint.completedAt,
      observedSteps: [...observed], latestState: state, pageErrors: errors,
    }), null, 2)}\n`);
  }
  async function confirmNoManualActions() {
    await expect(page.getByTestId('confirm-script')).toHaveCount(0);
    await expect(page.getByTestId('confirm-video')).toHaveCount(0);
    await expect(page.getByTestId('approve-images')).toHaveCount(0);
  }
  try {
    await page.addInitScript(({ apiBase, session }) => {
      localStorage.setItem('outfit.server', apiBase);
      localStorage.setItem('outfit.onboarding.v1', 'done');
      localStorage.setItem('outfit.privacy-consent', '2026-10-21');
      // 新登录取得的会话必须跨导航保留，不能再次注入已过期的断点会话。
      if (!sessionStorage.getItem('outfit.live-auto.seeded')) {
        if (session) sessionStorage.setItem('outfit.session', session);
        sessionStorage.setItem('outfit.live-auto.seeded', 'done');
      }
    }, { apiBase: base, session: checkpoint.session });
    await page.goto('/');
    if (checkpoint.registered && checkpoint.session) {
      const checked = await page.request.get(`${base}/api/me`, { headers: { Authorization: `Bearer ${checkpoint.session}` } });
      if (checked.status() === 401) {
        checkpoint.session = undefined; await persist();
        await page.evaluate(() => sessionStorage.removeItem('outfit.session'));
        await page.goto('/login');
      } else expect(checked.ok(), '读取断点账号状态应成功').toBe(true);
    }
    if (!checkpoint.registered) {
      await page.getByRole('button', { name: '注册', exact: true }).click();
      await page.getByLabel('怎么称呼你', { exact: true }).fill('一键片场');
      await page.getByLabel('用户名', { exact: true }).fill(checkpoint.username);
      await page.getByLabel('密码', { exact: true }).fill(checkpoint.password);
      await page.getByRole('checkbox', { name: '我已阅读并同意《用户协议》和《隐私政策》' }).check();
      await page.getByRole('button', { name: '创建账号，开始创作', exact: true }).click();
      await page.getByRole('button', { name: '我已保存', exact: true }).click();
      await expect(page.getByRole('button', { name: '拍一组新片', exact: true })).toBeVisible();
      const session = await page.evaluate(() => sessionStorage.getItem('outfit.session') ?? undefined);
      expect(session, '注册后应持有会话').toBeTruthy();
      checkpoint.registered = true; checkpoint.session = session;
      await persist();
      await shot('01-registered');
    } else {
      const loginButton = page.getByRole('button', { name: '登录，继续创作', exact: true });
      await expect(loginButton.or(page.getByRole('button', { name: '拍一组新片', exact: true }))).toBeVisible();
      if (!checkpoint.session || await loginButton.isVisible()) {
        await page.getByLabel('用户名', { exact: true }).fill(checkpoint.username);
        await page.getByLabel('密码', { exact: true }).fill(checkpoint.password);
        const login = page.waitForResponse(response => response.url() === `${base}/api/auth/login` && response.request().method() === 'POST');
        await loginButton.click();
        const response = await login; expect(response.ok()).toBe(true);
        checkpoint.session = ((await response.json()) as AuthResponse).token;
        await persist();
        await expect(page.getByRole('button', { name: '拍一组新片', exact: true })).toBeVisible();
      }
    }
    if (!checkpoint.projectId && checkpoint.sent['auto-create']) {
      const response = await page.request.get(`${base}/api/projects`, { headers: { Authorization: `Bearer ${checkpoint.session}` } });
      expect(response.ok()).toBe(true);
      const found = ((await response.json()) as Project[]).filter(project => project.title === checkpoint.projectTitle && project.mode === 'auto');
      if (found.length !== 1) throw new Error('上次开拍结果尚未确认；请先核对服务端记录，本测试不会重复开拍。');
      checkpoint.projectId = found[0].id; await persist();
    }
    if (!checkpoint.projectId) {
      await page.getByRole('button', { name: '拍一组新片', exact: true }).click();
      await page.getByTestId('mode-auto').click();
      await expect(page.getByTestId('mode-description')).toContainText('全套图文和视频一次出好');
      await page.getByLabel('项目名称', { exact: true }).fill(checkpoint.projectTitle);
      await page.getByLabel('这次想拍什么', { exact: true }).fill(process.env.LIVE_BRIEF || '米白亚麻衬衫，保留面料、纽扣和胸袋细节，去掉吊牌。自然窗光、松弛通勤，做三张照片的完整图文和短视频。');
      // 默认用调研期的衬衫样张；LIVE_GARMENTS 可传自己的衣服图（逗号分隔路径）走同一条链路。
      const garmentFiles = (process.env.LIVE_GARMENTS || '').split(',').map(item => item.trim()).filter(Boolean);
      const garments = garmentFiles.length > 0
        ? await Promise.all(garmentFiles.map(async file => ({ name: path.basename(file), mimeType: 'image/jpeg', buffer: await sharp(file).jpeg({ quality: 95 }).toBuffer() })))
        : [{ name: 'auto-shirt.jpg', mimeType: 'image/jpeg', buffer: await sharp(path.resolve('../docs/spike/inputs.jpg')).extract({ left: 0, top: 0, width: 450, height: 600 }).jpeg({ quality: 95 }).toBuffer() }];
      for (const [index, garment] of garments.entries()) {
        const chooser = page.waitForEvent('filechooser');
        await page.getByTestId('upload-garments').click();
        await (await chooser).setFiles(garment);
        await expect(page.getByRole('button', { name: `移除衣服图 ${index + 1}`, exact: true })).toBeVisible({ timeout: 60_000 });
      }
      await expect(page.getByTestId('start-shooting')).toHaveText(/开拍，全自动 · 约 [\d.]+ 点/);
      await expect(page.getByTestId('start-shooting')).toBeEnabled();
      await shot('02-auto-ready');
      await performLiveOnce(checkpoint, 'auto-create', persist, async () => {
        const created = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().method() === 'POST');
        await page.getByTestId('start-shooting').click();
        const response = await created;
        expect(response.ok()).toBe(true);
        const input = response.request().postDataJSON();
        expect(input.mode).toBe('auto'); expect(input.style_tags.length).toBeGreaterThan(0);
        const project = await response.json() as Project;
        checkpoint.projectId = project.id; await persist();
      }, observedRequest => {
        const listener = (request: Request) => { if (request.method() === 'POST' && request.url() === `${base}/api/projects`) observedRequest(); };
        page.on('request', listener); return () => page.off('request', listener);
      });
    }
    await page.goto(`/projects/${encodeURIComponent(checkpoint.projectId!)}`);
    await expect(page.getByTestId('auto-progress')).toBeVisible();
    while (Date.now() < deadline) {
      // 独立只读采样比 App 的常规轮询更快；页面仍由真实 App 自己更新。
      const response = await page.request.get(`${base}/api/projects/${encodeURIComponent(checkpoint.projectId!)}/state`, {
        headers: { Authorization: `Bearer ${checkpoint.session}` }, timeout: Math.min(10_000, Math.max(1, deadline - Date.now())),
      });
      expect(response.ok(), '轮询一键出片状态应成功').toBe(true);
      state = await response.json() as ProjectState;
      if (state) {
        if (state.mode !== 'auto') throw new Error(`自动拍摄已停止，当前阶段 ${state.stage}，请打开编导间查看原因后接手。`);
        expect(state.pending_action ?? null).toBeNull();
        await confirmNoManualActions();
        const current = state;
        const step = current.auto?.step;
        if (step && !observed.has(step)) {
          // 页面每 5 秒刷新一次；写笔记这类几秒就完成的步骤可能在页面刷新前已被下一步替代，这时只记录服务端观察到的步骤。
          try {
            await expect(page.getByTestId('auto-current-step'), `步骤 ${step} 必须先在真实页面出现才能截图`).toHaveText(current.auto!.label, { timeout: Math.min(15_000, Math.max(1, deadline - Date.now())) });
            await page.getByTestId('auto-progress').scrollIntoViewIfNeeded();
            await shot(`03-step-${step}`);
          } catch (error) {
            const latest = await page.request.get(`${base}/api/projects/${encodeURIComponent(checkpoint.projectId!)}/state`, { headers: { Authorization: `Bearer ${checkpoint.session}` } });
            const moved = latest.ok() && ((await latest.json()) as ProjectState).auto?.step !== step;
            if (!moved) throw error;
          }
          observed.add(step);
          await evidence();
        }
        if (state.stage === 'done' && state.auto?.step === 'done') break;
      }
      await page.waitForTimeout(500);
    }
    expect(state?.stage, '十分钟内应推进到 done').toBe('done');
    expect(state?.auto?.step).toBe('done');
    expect(state?.video?.status).toBe('succeeded');
    expect(state?.note?.title).toBeTruthy();
    expect(state?.images.some(image => image.status === 'succeeded')).toBe(true);
    await expect(page.getByTestId('auto-current-step')).toContainText(state!.auto!.label);
    await confirmNoManualActions();
    await expect(page.locator('body')).not.toContainText(/[¥元]/);
    expect(errors).toEqual([]);
    const missing = requiredSteps.filter(step => !observed.has(step));
    expect(missing, `一键出片已完成，但缺少步骤截图：${missing.join('、')}。证据不完整，不能判定每步截图通过。`).toEqual([]);
    checkpoint.completedAt = new Date().toISOString();
    await shot('04-done'); await evidence();
  } catch (error) {
    await shot('failure').catch(() => undefined);
    await evidence();
    throw error;
  }
});
