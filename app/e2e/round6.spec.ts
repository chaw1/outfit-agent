import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { formatPoints, pointsValue } from '../src/lib/transparency';
import type { Asset, AuthResponse, Message, Project, ProjectState } from '../src/api/types';

const apiBase = process.env.E2E_API_BASE || 'http://localhost:19301/api';
const shots = path.resolve('screenshots');
const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
const evidence: Record<string, unknown> = {};

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
  await page.screenshot({ path: path.join(shots, name), animations: 'disabled' });
}

async function setup(page: Page, request: APIRequestContext, label: string) {
  const registered = await request.post(`${apiBase}/auth/register`, { data: { username: `round6_${label}_${Date.now()}`, password: 'Local-round6-2026', nickname: '第六轮验收' } });
  expect(registered.ok()).toBe(true);
  const auth = await registered.json() as AuthResponse;
  const headers = { Authorization: `Bearer ${auth.token}` };
  const fixture = await readFile(path.resolve('../docs/spike/inputs.jpg'));
  const uploaded = await request.post(`${apiBase}/assets`, { headers, multipart: { kind: 'garment', file: { name: 'round6-shirt.jpg', mimeType: 'image/jpeg', buffer: fixture } } });
  expect(uploaded.ok()).toBe(true);
  const garment = await uploaded.json() as Asset;
  const created = await request.post(`${apiBase}/projects`, { headers, data: { title: `第六轮${label}验收`, brand: 'LOCAL STUDIO', brief: '喜欢松弛感、日常通勤，保留浅色衬衫和自然面料细节。', garment_asset_ids: [garment.id] } });
  expect(created.ok()).toBe(true);
  const project = await created.json() as Project;
  await page.addInitScript(({ token, base }) => {
    sessionStorage.setItem('outfit.session', token);
    localStorage.setItem('outfit.server', base); localStorage.setItem('outfit.privacy-consent', '2026-10-21');
    localStorage.setItem('outfit.onboarding.v1', 'done');
  }, { token: auth.token, base: process.env.E2E_MOCK_BASE || 'http://localhost:19301' });
  async function state(): Promise<ProjectState> {
    const response = await request.get(`${apiBase}/projects/${project.id}/state`, { headers });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  async function messages(): Promise<Message[]> {
    const response = await request.get(`${apiBase}/projects/${project.id}/messages`, { headers });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  return { headers, garment, project, state, messages };
}

test('第六轮：每轮过程、同 id 换方向卡与付费前预估贯穿本地全流程', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { project, state, messages } = await setup(page, request, '全流程');
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByTestId('regenerate-directions')).toBeEnabled();
  const initial = await state();
  const initialHistory = await messages();
  const directionCard = initialHistory.flatMap(message => message.cards).find(card => card.type === 'directions');
  expect(directionCard).toBeTruthy();
  const firstTrace = initialHistory.find(message => message.role === 'assistant')!;
  expect(firstTrace.trace).toBeTruthy();
  const summary = page.getByTestId(`trace-${firstTrace.id}`);
  await expect(summary).toContainText(/用了.+·.+s.+·.+点/);
  await expect(page.getByTestId(`trace-steps-${firstTrace.id}`)).toHaveCount(0);
  await summary.click();
  const steps = page.getByTestId(`trace-steps-${firstTrace.id}`);
  await expect(steps).toBeVisible();
  for (const step of firstTrace.trace!.steps) await expect(steps).toContainText(step.label);
  await screenshot(page, '53-agent-trace-expanded.png', summary);
  await summary.click();
  await expect(steps).toHaveCount(0);

  const swapRequest = page.waitForRequest(value => value.method() === 'POST' && value.url().endsWith('/messages') && value.postDataJSON()?.text === '换一组方向，保留我刚才说的偏好');
  await page.getByTestId('regenerate-directions').click();
  expect((await swapRequest).postDataJSON()).toEqual({ text: '换一组方向，保留我刚才说的偏好' });
  await expect.poll(async () => (await state()).directions.map(direction => direction.name)).not.toEqual(initial.directions.map(direction => direction.name));
  await expect(page.getByTestId('regenerate-directions')).toBeEnabled();
  const changed = await state();
  const changedDirection = changed.directions[0];
  expect(changed.directions.length).toBeGreaterThanOrEqual(2);
  expect(changed.directions.length).toBeLessThanOrEqual(3);
  await expect(page.getByTestId(`card-${directionCard!.id}`)).toHaveCount(1);
  for (const original of initial.directions) await expect(page.getByRole('button', { name: `选择方向：${original.name}`, exact: true })).toHaveCount(0);
  await expect(page.getByTestId(`preview-image-${changedDirection.id}`)).toBeVisible();
  await expect.poll(async () => (await state()).active_jobs.length).toBe(0);
  await screenshot(page, '54-regenerated-directions-preview.png', page.getByTestId(`direction-${changedDirection.id}`));
  await page.getByTestId(`direction-${changedDirection.id}`).click();
  const confirmScript = page.getByTestId('confirm-script');
  await expect(confirmScript).toBeEnabled();
  const scriptState = await state();
  expect(scriptState.pending_action?.estimated_cost_cny).toBeGreaterThan(0);
  const scriptEstimate = page.getByTestId('cost-estimate-confirm_script');
  await expect(scriptEstimate).toContainText('预计 ');
  await expect(scriptEstimate).toContainText('今日还有 ');
  await expect(scriptEstimate).toContainText(formatPoints(pointsValue(scriptState.pending_action!.estimated_cost_points, scriptState.pending_action!.estimated_cost_cny)!));
  await expect(scriptEstimate).toContainText(formatPoints(pointsValue(scriptState.budget!.remaining_points, scriptState.budget!.remaining_cny)!));
  await screenshot(page, '55-script-estimate-and-budget.png', scriptEstimate);

  // Block history recovery so only token/trace stream events can update this reply.
  const beforeRewrite = await messages();
  const rewrittenId = beforeRewrite.at(-1)!.id;
  expect(beforeRewrite.at(-1)!.can_regenerate).toBe(true);
  await expect(page.getByTestId('rephrase-message')).toBeVisible();
  const beforeRewriteBubbles = await page.getByTestId(/^message-/).count();
  let blockedReads = 0;
  const unavailable = { error: { code: 'LOCAL_HISTORY_UNAVAILABLE', message: '本地验收：刷新暂时不可用' } };
  const blockedState = `${apiBase}/projects/${project.id}/state`;
  const blockedMessages = `${apiBase}/projects/${project.id}/messages`;
  await page.route(blockedState, route => {
    if (route.request().method() !== 'GET') return route.continue();
    blockedReads += 1;
    return route.fulfill({ status: 503, headers: corsHeaders, json: unavailable });
  });
  await page.route(blockedMessages, route => {
    if (route.request().method() !== 'GET') return route.continue();
    blockedReads += 1;
    return route.fulfill({ status: 503, headers: corsHeaders, json: unavailable });
  });
  const rewrite = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages') && response.request().postDataJSON()?.action?.type === 'regenerate_reply');
  await page.getByTestId('rephrase-message').click();
  const rewriteResponse = await rewrite;
  expect(rewriteResponse.ok()).toBe(true);
  await expect(page.getByTestId(`message-${rewrittenId}`)).toContainText('换个表达：');
  await expect(page.getByTestId(`trace-${rewrittenId}`)).toContainText('用了 对话');
  await expect.poll(() => blockedReads).toBeGreaterThan(0);
  await expect(confirmScript).toBeEnabled();
  await expect(page.getByTestId(/^message-/)).toHaveCount(beforeRewriteBubbles);
  await expect(page.getByTestId(/^message-local-/)).toHaveCount(0);
  await expect(page.getByTestId(`message-${rewrittenId}`)).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('刷新暂时不可用');
  await screenshot(page, '56-same-id-rewrite-stream-trace.png', page.getByTestId(`trace-${rewrittenId}`));
  await page.unroute(blockedState);
  await page.unroute(blockedMessages);
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(confirmScript).toBeEnabled();
  const afterRewrite = await messages();
  expect(afterRewrite).toHaveLength(beforeRewrite.length);
  expect(afterRewrite.at(-1)!.id).toBe(rewrittenId);
  expect((await state()).cost_cny).toBe(scriptState.cost_cny);

  // The service has committed a second rewrite, but this response loses trace/done.
  // Recovery must accept the existing id instead of waiting for a new assistant id.
  let interruptedRewrite = false;
  await page.route(blockedMessages, async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON()?.action?.type !== 'regenerate_reply' || interruptedRewrite) return route.continue();
    interruptedRewrite = true;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const stream = await response.text();
    expect(stream).toContain('event: done');
    const firstToken = stream.match(/^event: token\ndata: [^\n]+\n\n/m)?.[0];
    expect(firstToken).toBeTruthy();
    await route.fulfill({ response, body: firstToken! });
  });
  await expect(page.getByTestId('rephrase-message')).toBeVisible();
  const interruptedResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages') && response.request().postDataJSON()?.action?.type === 'regenerate_reply');
  await page.getByTestId('rephrase-message').click();
  await interruptedResponse;
  expect(interruptedRewrite).toBe(true);
  const recoveredHistory = await messages();
  expect(recoveredHistory).toHaveLength(beforeRewrite.length);
  expect(recoveredHistory.at(-1)!.id).toBe(rewrittenId);
  expect(recoveredHistory.at(-1)!.text).toMatch(/^我换种方式说：/);
  await expect(page.getByTestId(`message-${rewrittenId}`)).toHaveText(recoveredHistory.at(-1)!.text);
  await expect(page.getByTestId('rephrase-message')).toBeVisible();
  await expect(page.getByTestId(/^message-/)).toHaveCount(beforeRewriteBubbles);
  await expect(page.getByTestId(/^message-local-/)).toHaveCount(0);
  await expect(page.getByTestId(/^failed-/)).toHaveCount(0);
  await screenshot(page, '64-same-id-disconnect-recovered.png', page.getByTestId(`trace-${rewrittenId}`));
  await page.unroute(blockedMessages);
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(confirmScript).toBeEnabled();
  await confirmScript.click();
  await expect.poll(async () => {
    const current = await state();
    return current.active_jobs.length === 0 && current.images.some(image => image.status === 'succeeded');
  }, { timeout: 90_000 }).toBe(true);
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  await page.getByTestId('approve-images').click();
  await expect(page.getByTestId('confirm-video')).toBeEnabled();
  const noteState = await state();
  const videoEstimate = page.getByTestId('cost-estimate-confirm_video');
  await expect(videoEstimate).toContainText(formatPoints(pointsValue(noteState.pending_action!.estimated_cost_points, noteState.pending_action!.estimated_cost_cny)!));
  await expect(videoEstimate).toContainText(formatPoints(pointsValue(noteState.budget!.remaining_points, noteState.budget!.remaining_cny)!));
  await screenshot(page, '57-video-estimate-and-budget.png', videoEstimate);
  await page.getByTestId('confirm-video').click();
  await expect(page.getByTestId('play-video')).toBeVisible({ timeout: 60_000 });
  const finalHistory = await messages();
  const assistantMessages = finalHistory.filter(message => message.role === 'assistant');
  expect(assistantMessages.length).toBeGreaterThanOrEqual(7);
  for (const message of assistantMessages) {
    expect(message.trace, `assistant ${message.id} 应返回 trace`).toBeTruthy();
    await expect(page.getByTestId(`trace-${message.id}`)).toHaveCount(1);
  }
  for (const message of finalHistory.filter(message => message.role === 'user')) await expect(page.getByTestId(`trace-${message.id}`)).toHaveCount(0);
  expect(errors).toEqual([]);
  evidence.flow = { projectId: project.id, directionCardId: directionCard!.id, fixedSwapText: true, sameCardIdSingleInstance: true, previewsReady: true, sameIdRewriteFromStream: true, rewriteHistoryBlocked: blockedReads, rewriteNoExtraMessages: true, rewriteCostUnchanged: true, sameIdRewriteDisconnectRecovered: true, rewriteDisconnectNoFailedUser: true, assistantTraceCount: assistantMessages.length, traceTools: [...new Set(assistantMessages.map(message => message.trace!.tool))], scriptEstimate: scriptState.pending_action!.estimated_cost_cny, scriptRemaining: scriptState.budget!.remaining_cny, videoEstimate: noteState.pending_action!.estimated_cost_cny, videoRemaining: noteState.budget!.remaining_cny, pageErrors: errors };
  await writeFile(path.join(shots, 'round6-evidence.json'), JSON.stringify(evidence, null, 2));
});

test('第六轮：旧字段缺失时隐藏过程与预估，出图和视频余额不足均禁止确认', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { project, headers, state, messages, garment } = await setup(page, request, '兼容与预算');
  const analyzed = await request.post(`${apiBase}/projects/${project.id}/messages`, { headers, data: { text: '请分析品牌衣服和合作需求，给我几个适合的穿搭方向。' } });
  expect(analyzed.ok()).toBe(true);
  const initial = await state();
  const choice = await request.post(`${apiBase}/projects/${project.id}/messages`, { headers, data: { action: { type: 'choose_direction', direction_id: initial.directions[0].id } } });
  expect(choice.ok()).toBe(true);
  const script = await state();
  const history = await messages();
  let current: ProjectState = structuredClone(script);
  let currentHistory: Message[] = structuredClone(history);
  await page.route(`${apiBase}/projects/${project.id}/state`, route => route.request().method() === 'GET' ? route.fulfill({ headers: corsHeaders, json: current }) : route.continue());
  await page.route(`${apiBase}/projects/${project.id}/messages`, route => route.request().method() === 'GET' ? route.fulfill({ headers: corsHeaders, json: currentHistory }) : route.continue());
  current.pending_action = { type: 'confirm_script', prompt: '确认后开始出图', estimated_cost_cny: 1.38 };
  current.budget = { tier: 'free', daily_budget_cny: 20, today_cost_cny: 19.9, remaining_cny: 0.1 };
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByTestId('cost-estimate-confirm_script')).toContainText('13.8 点');
  await expect(page.getByTestId('cost-estimate-confirm_script')).toContainText('1 点');
  await expect(page.getByTestId('confirm-script')).toBeDisabled();
  await expect(page.getByTestId('budget-insufficient-confirm_script')).toContainText(/点数不够/);
  await screenshot(page, '58-script-insufficient-budget.png', page.getByTestId('budget-insufficient-confirm_script'));

  delete current.budget;
  delete current.pending_action.estimated_cost_cny;
  currentHistory = currentHistory.map(message => { const legacy = { ...message }; delete legacy.trace; return legacy; });
  await page.reload();
  await expect(page.getByTestId('confirm-script')).toBeEnabled();
  await expect(page.getByTestId('cost-estimate-confirm_script')).toHaveCount(0);
  await expect(page.getByTestId(/^trace-/)).toHaveCount(0);
  await expect(page.getByTestId('budget-insufficient-confirm_script')).toHaveCount(0);
  await screenshot(page, '59-legacy-fields-hidden.png', page.getByTestId('confirm-script'));

  const imageId = 'round6-budget-image';
  const note = { title: '自然一点的秋日穿搭', body: '用自然面料记录通勤日常。', tags: ['秋日穿搭'], image_ids: [imageId] };
  current = { ...script, stage: 'note', images: [{ id: imageId, shot_id: 'round6-budget-shot', version: 1, status: 'succeeded', url: garment.url }], note, pending_action: { type: 'confirm_video', prompt: '确认生成视频', estimated_cost_cny: 1.2 }, budget: { tier: 'free', daily_budget_cny: 20, today_cost_cny: 19.9, remaining_cny: 0.1 }, active_jobs: [] };
  currentHistory = [...currentHistory, { id: 'round6-budget-note-message', role: 'assistant', text: '笔记已准备好。', cards: [{ id: `${project.id}_note`, type: 'note', ...note }], created_at: new Date().toISOString() }];
  await page.reload();
  await expect(page.getByTestId('cost-estimate-confirm_video')).toContainText('12 点');
  await expect(page.getByTestId('cost-estimate-confirm_video')).toContainText('1 点');
  await expect(page.getByTestId('confirm-video')).toBeDisabled();
  await expect(page.getByTestId('budget-insufficient-confirm_video')).toContainText(/点数不够/);
  await screenshot(page, '60-video-insufficient-budget.png', page.getByTestId('budget-insufficient-confirm_video'));
  delete current.budget;
  delete current.pending_action!.estimated_cost_cny;
  await page.reload();
  await expect(page.getByTestId('confirm-video')).toBeEnabled();
  await expect(page.getByTestId('cost-estimate-confirm_video')).toHaveCount(0);
  await expect(page.getByTestId('budget-insufficient-confirm_video')).toHaveCount(0);
  expect(errors).toEqual([]);
  evidence.compatibility = { traceMissingHidden: true, estimatedCostAndBudgetMissingHidden: true, legacyConfirmEnabled: true, imageBudgetInsufficientDisabled: true, videoBudgetInsufficientDisabled: true, pageErrors: errors };
  await writeFile(path.join(shots, 'round6-evidence.json'), JSON.stringify(evidence, null, 2));
});

test('第六轮：发帖表单的编辑、声明、图片顺序和草稿刷新恢复，发布使用编辑内容', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { project, state, garment } = await setup(page, request, '发帖表单');
  const original = await state();
  const imageIds = ['round6-form-image-1', 'round6-form-image-2'];
  const note = { title: '把秋天穿成一杯燕麦拿铁', body: '原始生成正文，不应被当成最终发布文案。', tags: ['秋日穿搭', '松弛感'], image_ids: imageIds, ai_label: '本篇含 AI 生成内容，发布时请勾选平台的 AI 内容声明。' };
  const formState: ProjectState = { ...original, stage: 'note', directions: [], active_jobs: [], pending_action: null, images: imageIds.map((id, index) => ({ id, shot_id: `round6-form-shot-${index}`, status: 'succeeded', version: 1, url: garment.url })), note };
  const shares: { title: string; text: string }[] = [];
  const downloads: string[] = [];
  page.on('download', download => { downloads.push(download.suggestedFilename()); });
  await page.exposeFunction('recordRound6Share', (payload: { title: string; text: string }) => { shares.push(payload); });
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { configurable: true, value: (payload: unknown) => (window as unknown as { recordRound6Share: (payload: unknown) => Promise<void> }).recordRound6Share(payload) }));
  await page.route(`${apiBase}/projects/${project.id}/state`, route => route.request().method() === 'GET' ? route.fulfill({ headers: corsHeaders, json: formState }) : route.continue());
  await page.goto(`/preview/${project.id}`);
  await expect(page.getByTestId('note-title')).toHaveValue(note.title);
  await expect(page.getByTestId('publish-ai-confirm')).toHaveAttribute('aria-checked', 'true');
  const editedTitle = '今天的松弛通勤穿搭';
  const editedBody = '这是我亲手编辑后的正文。\n自然面料和舒适鞋子，才是我的日常。';
  await page.getByTestId('note-title').fill('一二三四五六七八九十一二三四五六七八九十多余');
  await expect(page.getByTestId('note-title-count')).toContainText('20');
  await expect(page.getByTestId('note-title')).toHaveValue('一二三四五六七八九十一二三四五六七八九十');
  await page.getByTestId('note-title').fill(editedTitle);
  await expect(page.getByTestId('note-title-count')).toContainText(`${Array.from(editedTitle).length}`);
  await page.getByTestId('note-body').fill(editedBody);
  await page.getByTestId('remove-note-tag-秋日穿搭').click();
  await page.getByTestId('note-tag-input').fill('#舒服通勤');
  await page.getByTestId('add-note-tag').click();
  await expect(page.getByTestId('remove-note-tag-秋日穿搭')).toHaveCount(0);
  await expect(page.getByTestId('remove-note-tag-舒服通勤')).toBeVisible();
  await page.getByTestId(`move-note-image-${imageIds[1]}-earlier`).click();
  await page.getByTestId('publish-ai-confirm').click();
  await expect(page.getByTestId('prepare-publish')).toBeDisabled();
  await page.getByTestId('save-note-draft').click();
  await expect(page.getByTestId('note-draft-status')).toContainText('草稿已保存到本机');
  await screenshot(page, '61-note-form-draft-saved.png', page.getByTestId('note-title'));
  await page.reload();
  await expect(page.getByTestId('note-draft-status')).toContainText('已恢复本地草稿');
  await expect(page.getByTestId('note-title')).toHaveValue(editedTitle);
  await expect(page.getByTestId('note-body')).toHaveValue(editedBody);
  await expect(page.getByTestId('remove-note-tag-舒服通勤')).toHaveCount(1);
  await expect(page.getByTestId('remove-note-tag-秋日穿搭')).toHaveCount(0);
  await expect(page.getByTestId('publish-ai-confirm')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId(`move-note-image-${imageIds[1]}-earlier`)).toBeDisabled();
  await expect(page.getByTestId(`move-note-image-${imageIds[0]}-earlier`)).toBeEnabled();
  await screenshot(page, '62-note-draft-restored.png', page.getByTestId('note-draft-status'));
  await page.getByTestId('publish-ai-confirm').click();
  await expect(page.getByTestId('prepare-publish')).toBeEnabled();
  await page.getByTestId('prepare-publish').click();
  await expect(page.getByTestId('publish-share')).toContainText('系统分享面板已打开');
  expect(shares).toHaveLength(1);
  expect(shares[0].title).toBe(editedTitle);
  expect(shares[0].text).toContain(editedTitle);
  expect(shares[0].text).toContain(editedBody);
  expect(shares[0].text).toContain('#舒服通勤');
  expect(shares[0].text).toContain('#松弛感');
  expect(shares[0].text).not.toContain('#秋日穿搭');
  expect(shares[0].text).not.toContain(note.body);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(shares[0].text);
  expect(downloads).toEqual([expect.stringContaining(imageIds[1]), expect.stringContaining(imageIds[0])]);
  await screenshot(page, '63-edited-note-publish-ready.png', page.getByTestId('publish-checklist'));
  expect(errors).toEqual([]);
  evidence.form = { titleLimit: 20, titleCounter: true, bodyEditable: true, tagsAddRemove: true, aiDefaultChecked: true, aiCheckboxRestored: true, localDraftRestored: true, editedNoteSharedAndCopied: true, orderedDownloads: downloads, shares: shares.length, localOverride: true, pageErrors: errors };
  await writeFile(path.join(shots, 'round6-evidence.json'), JSON.stringify(evidence, null, 2));
});
