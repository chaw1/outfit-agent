import { expect, test, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Action, Asset, AuthResponse, Message, OutfitImage, Project, ProjectState } from '../src/api/types';

const server = 'http://localhost:19301';
const apiBase = `${server}/api`;
const shots = path.resolve('screenshots');
const evidence: Record<string, unknown> = {};
type EditAction = Extract<Action, { type: 'edit_image' }>;

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

async function saveEvidence() {
  await mkdir(shots, { recursive: true });
  await writeFile(path.join(shots, 'round8-evidence.json'), JSON.stringify(evidence, null, 2));
}

function actionRequest(type: Action['type']) {
  return (request: Request) => request.method() === 'POST' && request.url().endsWith('/messages') && request.postDataJSON()?.action?.type === type;
}

async function setup(page: Page, request: APIRequestContext, label: string) {
  const registered = await request.post(`${apiBase}/auth/register`, { data: { username: `round8_${label}_${Date.now()}`, password: 'Local-round8-2026', nickname: '第八轮验收' } });
  expect(registered.ok()).toBe(true);
  const auth = await registered.json() as AuthResponse;
  const headers = { Authorization: `Bearer ${auth.token}` };
  const fixture = await readFile(path.resolve('../docs/spike/inputs.jpg'));
  const uploaded = await request.post(`${apiBase}/assets`, { headers, multipart: { kind: 'garment', file: { name: 'round8-shirt.jpg', mimeType: 'image/jpeg', buffer: fixture } } });
  expect(uploaded.ok()).toBe(true);
  const garment = await uploaded.json() as Asset;
  const created = await request.post(`${apiBase}/projects`, { headers, data: { title: `第八轮${label}验收`, brand: 'LOCAL STUDIO', brief: '浅色衬衫，干净的日常通勤穿搭，保留衣服细节。', garment_asset_ids: [garment.id] } });
  expect(created.ok()).toBe(true);
  const project = await created.json() as Project;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ token, base }) => {
    sessionStorage.setItem('outfit.session', token);
    localStorage.setItem('outfit.server', base);
    localStorage.setItem('outfit.onboarding.v1', 'done');
  }, { token: auth.token, base: server });
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
  async function send(body: { action?: Action; text?: string }) {
    const response = await request.post(`${apiBase}/projects/${project.id}/messages`, { headers, data: body });
    expect(response.ok()).toBe(true);
    const result = await response.text();
    expect(result).not.toContain('event: error');
    return result;
  }
  async function generated() {
    await expect.poll(async () => {
      const current = await state();
      return current.images.length >= 3 && current.images.every(image => image.status === 'succeeded') && current.active_jobs.length === 0;
    }, { timeout: 70_000 }).toBe(true);
    return state();
  }
  async function child(action: EditAction, oldIds: string[]) {
    let image: OutfitImage | undefined;
    await expect.poll(async () => {
      image = (await state()).images.find(candidate => !oldIds.includes(candidate.id) && candidate.parent_id === action.image_id && candidate.status === 'succeeded');
      return image?.id;
    }, { timeout: 40_000 }).toBeTruthy();
    return image!;
  }
  return { project, headers, errors, state, messages, send, generated, child };
}

async function rectangle(page: Page) {
  const canvas = page.getByTestId('viewer-canvas');
  await expect(canvas).toBeVisible();
  await page.getByTestId('viewer-mode-local').click();
  await page.getByTestId('viewer-mode-rectangle').click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .65, box.y + box.height * .6, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('viewer-region-status')).toContainText('已框选');
}

async function selectedIds(page: Page) {
  return page.getByTestId(/^move-up-/).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!.replace('move-up-', '')));
}

test('第八轮：未通过改图手动采用、笔记换版、草稿冲突与明确的新尝试', async ({ page, request }) => {
  test.setTimeout(240_000);
  const context = await setup(page, request, '可信闭环');
  await page.goto(`/projects/${context.project.id}`);
  await expect(page.getByTestId('regenerate-directions')).toBeEnabled();
  await expect(page.getByTestId('regenerate-estimate')).toContainText('约 ¥1.50 · 含 2–3 张预览');
  await screenshot(page, '77-directions-regenerate-estimate.png', page.getByTestId('regenerate-estimate'));
  const initial = await context.state();
  await page.getByTestId(`direction-${initial.directions[0].id}`).click();
  await expect(page.getByTestId('confirm-script')).toBeEnabled();
  await page.getByTestId('confirm-script').click();
  const generated = await context.generated();
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  const original = generated.images[0];
  const beforeEdit = generated.images.map(image => image.id);
  await page.getByTestId(`image-select-${original.id}`).click();
  await rectangle(page);
  await page.getByTestId('edit-instruction').fill('袖口放下来');
  const firstSubmission = page.waitForRequest(actionRequest('edit_image'));
  await page.getByTestId('submit-edit').click();
  const firstAction = (await firstSubmission).postDataJSON().action as EditAction;
  expect(firstAction.attempt).toMatch(/^[0-9a-f-]{36}$/i);
  expect(firstAction.region).toBeDefined();
  const unverified = await context.child(firstAction, beforeEdit);
  expect(unverified.edit_check?.passed).toBe(false);
  await expect(page.getByTestId(`viewer-edit-check-${unverified.id}`)).toContainText('可能没改到位');
  await page.getByTestId('viewer-close').click();
  await expect(page.getByTestId(`image-toggle-${original.id}`)).toHaveText('1');
  await expect(page.getByTestId(`image-toggle-${unverified.id}`)).toHaveText('');
  const defaults = await selectedIds(page);
  expect(defaults).toContain(original.id);
  expect(defaults).not.toContain(unverified.id);
  await expect(page.getByTestId(`image-select-${unverified.id}`)).toContainText('未改到位');
  await screenshot(page, '78-unverified-does-not-replace-default.png', page.getByTestId(`image-select-${unverified.id}`));

  await page.getByTestId(`image-select-${unverified.id}`).click();
  await expect(page.getByTestId('viewer-adopt-version')).toContainText('仍然采用');
  await page.getByTestId('viewer-adopt-version').click();
  await expect(page.getByTestId('unverified-confirmation')).toBeVisible();
  await expect(page.getByTestId('unverified-reason')).toContainText(unverified.edit_check!.reason);
  await screenshot(page, '79-unverified-adoption-confirmation.png');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('unverified-confirmation')).not.toBeVisible();
  await expect(page.getByTestId('image-viewer')).toBeVisible();
  await page.getByTestId('viewer-adopt-version').click();
  await expect(page.getByTestId('unverified-confirmation')).toBeVisible();
  await page.getByTestId('cancel-unverified').click();
  await expect(page.getByTestId('unverified-confirmation')).not.toBeVisible();
  await expect(page.getByTestId('image-viewer')).toBeVisible();
  await page.getByTestId('viewer-adopt-version').click();
  await page.getByTestId('confirm-unverified').click();
  await page.getByTestId('viewer-close').click();
  const adoptedOrder = await selectedIds(page);
  expect(adoptedOrder).toEqual(defaults.map(id => id === original.id ? unverified.id : id));
  const approval = page.waitForRequest(actionRequest('approve_images'));
  await page.getByTestId('approve-images').click();
  const approvalAction = (await approval).postDataJSON().action as Extract<Action, { type: 'approve_images' }>;
  expect(approvalAction.image_ids).toEqual(adoptedOrder);
  expect(approvalAction.accept_unverified).toEqual([unverified.id]);
  await expect(page.getByTestId('preview-note')).toBeVisible();
  const manuallyAdopted = await context.state();
  expect(manuallyAdopted.note?.accepted_unverified_ids).toEqual([unverified.id]);
  await page.getByTestId('preview-note').click();
  await expect(page.getByTestId(`preview-image-${unverified.id}`)).toBeVisible();
  await expect(page.getByText('手动采用', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId(`publish-image-${unverified.id}`)).toContainText('手动采用');
  await screenshot(page, '80-preview-manually-adopted-image.png');
  const localTitle = '我自己改的穿搭标题';
  await page.getByTestId('note-title').fill(localTitle);
  await page.getByTestId('save-note-draft').click();
  await expect(page.getByTestId('note-draft-status')).toContainText('草稿已保存到本机');

  await page.goto(`/projects/${context.project.id}`);
  await expect(page.getByTestId('reselect-images')).toBeVisible();
  await page.getByTestId('reselect-images').click();
  await page.getByTestId(`image-select-${unverified.id}`).click();
  await expect(page.getByTestId('viewer-retry-edit')).toBeVisible();
  const beforeRetry = (await context.state()).images.map(image => image.id);
  const retrySubmission = page.waitForRequest(actionRequest('edit_image'));
  await page.getByTestId('viewer-retry-edit').click();
  const retryAction = (await retrySubmission).postDataJSON().action as EditAction;
  expect(retryAction.attempt).toBeTruthy();
  expect(retryAction.attempt).not.toBe(firstAction.attempt);
  expect(retryAction.image_id).toBe(firstAction.image_id);
  expect(retryAction.instruction).toBe(firstAction.instruction);
  expect(retryAction.region).toEqual(firstAction.region);
  const verified = await context.child(retryAction, beforeRetry);
  expect(verified.edit_check?.passed).toBe(true);
  await expect(page.getByTestId(`viewer-version-${verified.id}`)).toBeVisible();
  await expect(page.getByTestId('viewer-adopt-version')).toContainText('采用此版本到笔记');
  await screenshot(page, '81-note-stage-adopt-new-version.png');
  const noteAdoption = page.waitForRequest(actionRequest('approve_images'));
  await page.getByTestId('viewer-adopt-version').click();
  const noteAction = (await noteAdoption).postDataJSON().action as Extract<Action, { type: 'approve_images' }>;
  const newOrder = adoptedOrder.map(id => id === unverified.id ? verified.id : id);
  expect(noteAction.image_ids).toEqual(newOrder);
  await expect.poll(async () => (await context.state()).note?.image_ids).toEqual(newOrder);
  expect((await context.state()).note?.accepted_unverified_ids).toEqual([]);
  await page.getByTestId('viewer-close').click();
  await page.getByTestId('preview-note').click();
  await expect(page.getByTestId('note-draft-conflict')).toContainText('笔记有新版本');
  await expect(page.getByTestId('note-title')).toHaveValue(localTitle);
  await screenshot(page, '82-draft-conflict-preserves-local-edits.png', page.getByTestId('note-draft-conflict'));
  await page.getByTestId('keep-note-draft').click();
  await expect(page.getByTestId('note-draft-conflict')).toHaveCount(0);
  await expect(page.getByTestId('note-title')).toHaveValue(localTitle);
  await expect(page.getByTestId(`preview-image-${unverified.id}`)).toBeVisible();
  await expect(page.getByText('手动采用', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId(`publish-image-${unverified.id}`)).toContainText('手动采用');
  await screenshot(page, '83-draft-conflict-keep-my-edits.png', page.getByTestId('note-title'));
  await context.send({ text: '服务端第二次修订：保留轻松自然的日常语气。' });
  await page.reload();
  await expect(page.getByTestId('note-draft-conflict')).toBeVisible();
  await page.getByTestId('adopt-server-note').click();
  const latestNote = (await context.state()).note!;
  await expect(page.getByTestId('note-title')).toHaveValue(latestNote.title);
  await expect(page.getByTestId('note-body')).toHaveValue(latestNote.body);
  await expect(page.getByTestId(`preview-image-${verified.id}`)).toBeVisible();
  await expect(page.getByTestId(`preview-image-${unverified.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`publish-image-${verified.id}`)).not.toContainText('手动采用');
  await screenshot(page, '84-draft-conflict-adopt-server-version.png', page.getByTestId('note-title'));
  await page.getByTestId('note-title').fill('恢复前的本地草稿');
  await page.getByTestId('restore-server-note').click();
  await expect(page.getByTestId('note-title')).toHaveValue(latestNote.title);
  await expect(page.getByTestId('restore-previous-note-draft')).toBeVisible();

  // Lose the first response after the server accepts it, then replay that same submission.
  const imagesBeforeReuse = (await context.state()).images.length;
  const messagesUrl = `${apiBase}/projects/${context.project.id}/messages`;
  let replayed = false;
  await page.route(messagesUrl, async route => {
    if (!actionRequest('edit_image')(route.request()) || replayed) return route.continue();
    replayed = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.goto(`/projects/${context.project.id}`);
  await page.getByTestId('reselect-images').click();
  // Direct note-card selection also replaces this shot in place rather than appending it.
  await page.getByTestId(`image-toggle-${original.id}`).click();
  const oldVersionOrder = newOrder.map(id => id === verified.id ? original.id : id);
  expect(await selectedIds(page)).toEqual(oldVersionOrder);
  await page.getByTestId('approve-images').click();
  await expect.poll(async () => (await context.state()).note?.image_ids).toEqual(oldVersionOrder);
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  await page.getByTestId(`image-toggle-${verified.id}`).click();
  expect(await selectedIds(page)).toEqual(newOrder);
  await page.getByTestId('approve-images').click();
  await expect.poll(async () => (await context.state()).note?.image_ids).toEqual(newOrder);
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  await screenshot(page, '88-note-reselection-keeps-shot-order.png', page.getByTestId('approve-images'));
  await page.getByTestId(`edit-image-${verified.id}`).click();
  await page.getByTestId('edit-instruction').fill('背景换成公园');
  const lostSubmission = page.waitForRequest(actionRequest('edit_image'));
  await page.getByTestId('submit-edit').click();
  const lostAction = (await lostSubmission).postDataJSON().action as EditAction;
  await expect(page.getByTestId('submit-edit')).toBeEnabled();
  const replaySubmission = page.waitForRequest(actionRequest('edit_image'));
  await page.getByTestId('submit-edit').click();
  const replayAction = (await replaySubmission).postDataJSON().action as EditAction;
  expect(replayAction).toEqual(lostAction);
  await expect(page.getByTestId('viewer-reused')).toContainText('这次和上次一样，没有重新生成');
  await expect(page.getByTestId('viewer-generation-status')).toHaveCount(0);
  expect((await context.state()).images.length).toBe(imagesBeforeReuse + 1);
  await screenshot(page, '85-reused-edit-stops-waiting.png');
  await page.unroute(messagesUrl);
  expect(context.errors).toEqual([]);
  evidence.flow = { projectId: context.project.id, defaultIds: defaults, unverifiedImageId: unverified.id, originalImageId: original.id, approvalAction, firstAttempt: firstAction.attempt, retryAttempt: retryAction.attempt, verifiedImageId: verified.id, noteOrder: newOrder, conflictKeep: true, conflictAdopt: true, restoreServer: true, reusedTaskStopsWaiting: replayed, transportReplayAttempt: replayAction.attempt, pageErrors: context.errors };
  await saveEvidence();
});

test('第八轮：服务端发现未核对通过时，确认原因后携带 accept_unverified 重发', async ({ page, request }) => {
  test.setTimeout(150_000);
  const context = await setup(page, request, '服务端兜底');
  await context.send({ text: '先给我几个方向' });
  const initial = await context.state();
  await context.send({ action: { type: 'choose_direction', direction_id: initial.directions[0].id } });
  await context.send({ action: { type: 'confirm_script' } });
  const generated = await context.generated();
  const original = generated.images[0];
  const action: EditAction = { type: 'edit_image', image_id: original.id, instruction: '袖口放下来', region: { x: .2, y: .3, w: .25, h: .2 }, attempt: 'round8-server-fallback' };
  await context.send({ action });
  const unverified = await context.child(action, generated.images.map(image => image.id));
  expect(unverified.edit_check?.passed).toBe(false);
  function omitCheck(image: OutfitImage) {
    if (image.id !== unverified.id) return image;
    const olderMetadata = { ...image };
    delete olderMetadata.edit_check;
    return olderMetadata;
  }
  await page.route(`${apiBase}/projects/${context.project.id}/state`, async route => {
    const response = await route.fetch();
    const state = await response.json() as ProjectState;
    state.images = state.images.map(omitCheck);
    await route.fulfill({ response, json: state });
  });
  const messagesUrl = `${apiBase}/projects/${context.project.id}/messages`;
  await page.route(messagesUrl, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const messages = await response.json() as Message[];
    for (const message of messages) message.cards = message.cards.map(card => card.type === 'images' ? { ...card, items: card.items.map(omitCheck) } : card);
    await route.fulfill({ response, json: messages });
  });
  const approvals: Extract<Action, { type: 'approve_images' }>[] = [];
  page.on('request', request => { if (actionRequest('approve_images')(request)) approvals.push(request.postDataJSON().action); });
  await page.goto(`/projects/${context.project.id}`);
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  expect(await selectedIds(page)).toContain(unverified.id);
  await page.getByTestId('approve-images').click();
  await expect(page.getByTestId('unverified-confirmation')).toBeVisible();
  await expect(page.getByTestId('unverified-reason')).toContainText('镜头 1');
  await expect(page.getByTestId('unverified-reason')).toContainText(unverified.edit_check!.reason);
  expect(approvals).toHaveLength(1);
  expect(approvals[0].accept_unverified || []).not.toContain(unverified.id);
  await screenshot(page, '86-server-unverified-fallback-confirmation.png');
  await page.getByTestId('confirm-unverified').click();
  await expect(page.getByTestId('preview-note')).toBeVisible();
  expect(approvals).toHaveLength(2);
  expect(approvals[1].image_ids).toEqual(approvals[0].image_ids);
  expect(approvals[1].accept_unverified).toContain(unverified.id);
  expect((await context.state()).note?.accepted_unverified_ids).toEqual([unverified.id]);
  await page.getByTestId('preview-note').click();
  await expect(page.getByText('手动采用', { exact: true }).first()).toBeVisible();
  await screenshot(page, '87-server-confirmed-manual-image-preview.png');
  expect(context.errors).toEqual([]);
  evidence.serverFallback = { projectId: context.project.id, unverifiedImageId: unverified.id, deniedFirst: true, approvals, persistedAccepted: true, pageErrors: context.errors };
  await saveEvidence();
});

test('第八轮：复用标记只在恢复后的 pending_action 中到达，也停止等待新版本', async ({ page, request }) => {
  test.setTimeout(150_000);
  const context = await setup(page, request, '快照复用');
  await context.send({ text: '先给我几个方向' });
  const initial = await context.state();
  await context.send({ action: { type: 'choose_direction', direction_id: initial.directions[0].id } });
  await context.send({ action: { type: 'confirm_script' } });
  const generated = await context.generated();
  const original = generated.images[0];
  const previous: EditAction = { type: 'edit_image', image_id: original.id, instruction: '背景亮一点', attempt: 'round8-snapshot-existing' };
  await context.send({ action: previous });
  await context.child(previous, generated.images.map(image => image.id));
  const before = await context.state();
  const stateUrl = `${apiBase}/projects/${context.project.id}/state`;
  const messagesUrl = `${apiBase}/projects/${context.project.id}/messages`;
  let replayResponseSent = false;
  let failedReads = 0;
  let recoveredReads = 0;
  await page.route(stateUrl, async route => {
    if (replayResponseSent && !failedReads) {
      failedReads += 1;
      await route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, json: { error: { code: 'LOCAL_SNAPSHOT_DELAY', message: '进度暂时没同步' } } });
      return;
    }
    const response = await route.fetch();
    const state = await response.json() as ProjectState;
    if (replayResponseSent) {
      recoveredReads += 1;
      state.pending_action = { type: 'edit_image', prompt: '已复用上次改图任务', reused: true };
    }
    await route.fulfill({ response, json: state });
  });
  await page.route(messagesUrl, async route => {
    if (!actionRequest('edit_image')(route.request())) return route.continue();
    const response = await route.fetch({ postData: JSON.stringify({ action: previous }) });
    const body = (await response.text()).replace(/,"reused":true/g, '');
    expect(body).not.toContain('"reused"');
    replayResponseSent = true;
    await route.fulfill({ response, body });
  });
  await page.goto(`/projects/${context.project.id}`);
  await page.getByTestId(`edit-image-${original.id}`).click();
  await page.getByTestId('edit-instruction').fill('背景亮一点');
  await page.getByTestId('submit-edit').click();
  await expect(page.getByTestId('viewer-reused')).toContainText('这次和上次一样，没有重新生成');
  await expect(page.getByTestId('viewer-generation-status')).toHaveCount(0);
  expect(failedReads).toBe(1);
  expect(recoveredReads).toBeGreaterThan(0);
  expect((await context.state()).images.map(image => image.id)).toEqual(before.images.map(image => image.id));
  expect((await context.state()).cost_cny).toBe(before.cost_cny);
  await screenshot(page, '89-reused-from-recovered-pending-action.png');
  expect(context.errors).toEqual([]);
  evidence.pendingReuse = { projectId: context.project.id, streamReuseFieldsOmitted: true, failedStateReads: failedReads, recoveredStateReads: recoveredReads, newImageIds: [], costUnchanged: true, pageErrors: context.errors };
  await saveEvidence();
});
