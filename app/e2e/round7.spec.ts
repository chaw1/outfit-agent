import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Asset, AuthResponse, CreateProjectInput, Message, OutfitImage, Project, ProjectState } from '../src/api/types';

const server = process.env.E2E_MOCK_BASE || 'http://localhost:19301';
const apiBase = `${server}/api`;
const shots = path.resolve('screenshots');
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

async function saveEvidence() {
  await mkdir(shots, { recursive: true });
  await writeFile(path.join(shots, 'round7-evidence.json'), JSON.stringify(evidence, null, 2));
}

async function setup(page: Page, request: APIRequestContext, label: string) {
  const registered = await request.post(`${apiBase}/auth/register`, { data: { username: `round7_${label}_${Date.now()}`, password: 'Local-round7-2026', nickname: '第七轮验收' } });
  expect(registered.ok()).toBe(true);
  const auth = await registered.json() as AuthResponse;
  const headers = { Authorization: `Bearer ${auth.token}` };
  const fixture = await readFile(path.resolve('../docs/spike/inputs.jpg'));
  const uploaded: Asset[] = [];
  const uploadKinds: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    // Chromium omits file multipart bodies; check the kind parsed and persisted by the API.
    if (response.request().method() === 'POST' && response.url() === `${apiBase}/assets` && response.ok()) void response.json().then((asset: Asset) => { uploaded.push(asset); uploadKinds.push(asset.kind); });
  });
  await page.addInitScript(({ token, base }) => {
    sessionStorage.setItem('outfit.session', token);
    localStorage.setItem('outfit.server', base); localStorage.setItem('outfit.privacy-consent', '2026-10-21');
    localStorage.setItem('outfit.onboarding.v1', 'done');
  }, { token: auth.token, base: server });
  async function upload(button: Locator, names: string[]) {
    const previous = uploaded.length;
    const chooser = page.waitForEvent('filechooser');
    await button.click();
    await (await chooser).setFiles(names.map(name => ({ name: `${name}.jpg`, mimeType: 'image/jpeg', buffer: fixture })));
    return previous;
  }
  async function form(referenceCount: number) {
    await page.goto('/projects/new');
    await page.getByLabel('项目名称', { exact: true }).fill(`第七轮 ${referenceCount} 张参考图`);
    await page.getByLabel('品牌', { exact: true }).fill('LOCAL STUDIO');
    await page.getByLabel('这次想拍什么', { exact: true }).fill('自然光、浅色衬衫和松弛的日常通勤氛围，保留衣服细节。');
    await upload(page.getByTestId('upload-garments'), ['round7-shirt']);
    await expect(page.getByRole('button', { name: '移除衣服图 1', exact: true })).toBeVisible();
    await expect.poll(() => uploaded.length).toBe(1);
  }
  async function create() {
    const creation = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === `${apiBase}/projects`);
    await page.getByRole('button', { name: '开拍，先聊灵感', exact: true }).click();
    const response = await creation;
    expect(response.ok()).toBe(true);
    const input = response.request().postDataJSON() as CreateProjectInput;
    const project = await response.json() as Project;
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByTestId('regenerate-directions')).toBeEnabled();
    return { project, input };
  }
  async function state(id: string): Promise<ProjectState> {
    const response = await request.get(`${apiBase}/projects/${id}/state`, { headers });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  async function messages(id: string): Promise<Message[]> {
    const response = await request.get(`${apiBase}/projects/${id}/messages`, { headers });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  return { headers, uploaded, uploadKinds, errors, upload, form, create, state, messages };
}

for (const referenceCount of [0, 1, 2]) {
  test(`第七轮：新建合作可带 ${referenceCount} 张参考图，创建请求与卡片一致`, async ({ page, request }) => {
    const context = await setup(page, request, `refs${referenceCount}`);
    await context.form(referenceCount);
    await expect(page.getByTestId('reference-count')).toContainText('0/3');
    if (!referenceCount) await screenshot(page, '65-new-project-optional-references.png', page.getByTestId('upload-references'));
    if (referenceCount) {
      await context.upload(page.getByTestId('upload-references'), Array.from({ length: referenceCount }, (_, index) => `round7-reference-${index}`));
      await expect(page.getByTestId('reference-count')).toContainText(`${referenceCount}/3`);
      await expect.poll(() => context.uploaded.filter(asset => asset.kind === 'reference').length).toBe(referenceCount);
    }
    const references = context.uploaded.filter(asset => asset.kind === 'reference');
    const { project, input } = await context.create();
    expect(input.reference_asset_ids || []).toEqual(references.map(asset => asset.id));
    expect(project.reference_asset_ids || []).toEqual(references.map(asset => asset.id));
    expect(context.uploadKinds).toEqual(['garment', ...references.map(() => 'reference')]);
    const history = await context.messages(project.id);
    const card = history.flatMap(message => message.cards).find(value => value.type === 'references');
    if (!referenceCount) {
      expect(card).toBeUndefined();
      await expect(page.getByTestId(/^references-card-/)).toHaveCount(0);
    } else {
      expect(card?.type).toBe('references');
      if (card?.type !== 'references') throw new Error('参考图卡缺失');
      expect(card.items.map(item => item.asset_id)).toEqual(references.map(asset => asset.id));
      await expect(page.getByTestId(`references-card-${card.id}`)).toHaveCount(1);
      for (const item of card.items) {
        const tile = page.getByTestId(`reference-item-${item.asset_id}`);
        await expect(tile).toBeVisible();
        expect(item.style_tags.length).toBeGreaterThan(0);
        for (const tag of item.style_tags) await expect(tile).toContainText(tag);
      }
    }
    expect(context.errors).toEqual([]);
    evidence[`references${referenceCount}`] = { projectId: project.id, count: referenceCount, uploadKinds: context.uploadKinds, createdReferenceIds: input.reference_asset_ids || [], cardPresent: !!card, pageErrors: context.errors };
    await saveEvidence();
  });
}

function withoutConsistency(image: OutfitImage): OutfitImage {
  const legacy = structuredClone(image);
  delete legacy.anchor_id;
  if (legacy.fidelity) {
    delete legacy.fidelity.person_score;
    delete legacy.fidelity.anchor_score;
  }
  return legacy;
}

test('第七轮：参考图上限、删除再加、人像与封面锚点贯穿生成和历史恢复，旧字段缺失时隐藏', async ({ page, request }) => {
  test.setTimeout(240_000);
  const context = await setup(page, request, 'flow');
  await context.form(3);
  await context.upload(page.getByTestId('upload-references'), ['reference-a', 'reference-b', 'reference-c', 'reference-overflow']);
  await expect(page.getByTestId('reference-count')).toContainText('3/3');
  await expect(page.getByTestId('upload-references')).toBeDisabled();
  await expect.poll(() => context.uploaded.filter(asset => asset.kind === 'reference').length).toBe(3);
  const firstReferences = context.uploaded.filter(asset => asset.kind === 'reference');
  for (const asset of firstReferences) await expect(page.getByTestId(`reference-asset-${asset.id}`)).toBeVisible();
  await expect(page.getByRole('button', { name: '移除参考图 4', exact: true })).toHaveCount(0);
  await screenshot(page, '66-references-three-limit.png', page.getByTestId('reference-count'));
  await page.getByRole('button', { name: '移除参考图 2', exact: true }).click();
  await expect(page.getByTestId(`reference-asset-${firstReferences[1].id}`)).toHaveCount(0);
  await expect(page.getByTestId('reference-count')).toContainText('2/3');
  await expect(page.getByTestId('upload-references')).toBeEnabled();
  await context.upload(page.getByTestId('upload-references'), ['reference-replacement']);
  await expect(page.getByTestId('reference-count')).toContainText('3/3');
  await expect.poll(() => context.uploaded.filter(asset => asset.kind === 'reference').length).toBe(4);
  const replacement = context.uploaded.filter(asset => asset.kind === 'reference')[3];
  const selectedReferenceIds = [firstReferences[0].id, firstReferences[2].id, replacement.id];
  await expect(page.getByTestId(`reference-asset-${replacement.id}`)).toBeVisible();
  await screenshot(page, '67-references-remove-and-replace.png', page.getByTestId('reference-count'));
  await context.upload(page.getByRole('button', { name: '上传我的照片', exact: true }), ['round7-portrait']);
  await expect(page.getByRole('button', { name: '更换我的照片', exact: true })).toBeEnabled();
  await expect.poll(() => context.uploaded.filter(asset => asset.kind === 'model').length).toBe(1);
  const model = context.uploaded.find(asset => asset.kind === 'model')!;
  const { project, input } = await context.create();
  expect(input.reference_asset_ids).toEqual(selectedReferenceIds);
  expect(project.reference_asset_ids).toEqual(selectedReferenceIds);
  expect(input.model_asset_id).toBe(model.id);
  expect(context.uploadKinds).toEqual(['garment', 'reference', 'reference', 'reference', 'reference', 'model']);
  const initialHistory = await context.messages(project.id);
  const referencesCard = initialHistory.flatMap(message => message.cards).find(card => card.type === 'references');
  expect(referencesCard?.type).toBe('references');
  if (referencesCard?.type !== 'references') throw new Error('参考图卡缺失');
  expect(referencesCard.items.map(item => item.asset_id)).toEqual(selectedReferenceIds);
  const referenceCardLocator = page.getByTestId(`references-card-${referencesCard.id}`);
  await expect(referenceCardLocator).toHaveCount(1);
  for (const item of referencesCard.items) {
    expect(item.style_tags.length).toBeGreaterThan(0);
    const tile = page.getByTestId(`reference-item-${item.asset_id}`);
    for (const tag of item.style_tags) await expect(tile).toContainText(tag);
  }
  await screenshot(page, '68-references-style-card.png', referenceCardLocator);
  const initial = await context.state(project.id);
  await page.getByTestId(`direction-${initial.directions[0].id}`).click();
  await expect(page.getByTestId('confirm-script')).toBeEnabled();
  await page.getByTestId('confirm-script').click();
  await expect.poll(async () => {
    const state = await context.state(project.id);
    return !state.active_jobs.length && state.images.length >= 3 && state.images.every(image => image.status === 'succeeded');
  }, { timeout: 90_000 }).toBe(true);
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  const generated = await context.state(project.id);
  const anchored = generated.images.find(image => image.anchor_id && typeof image.fidelity?.person_score === 'number');
  expect(anchored, '有本人照和参考图时，非封面图应带封面锚点与人像分').toBeTruthy();
  const image = anchored!;
  expect(generated.images.some(candidate => candidate.id === image.anchor_id)).toBe(true);
  expect(image.fidelity!.person_score).toBeGreaterThanOrEqual(0);
  expect(image.fidelity!.person_score).toBeLessThanOrEqual(100);
  expect(image.fidelity!.anchor_score).toBeGreaterThanOrEqual(0);
  expect(image.fidelity!.anchor_score).toBeLessThanOrEqual(100);
  const personLabel = `人像 ${Math.round(image.fidelity!.person_score!)}`;
  await expect(page.getByTestId(`person-fidelity-${image.id}`)).toContainText(personLabel);
  await screenshot(page, '69-person-fidelity-badge.png', page.getByTestId(`image-select-${image.id}`));
  await page.getByTestId(`image-select-${image.id}`).click();
  await expect(page.getByTestId('image-viewer')).toBeVisible();
  await expect(page.getByTestId(`viewer-person-fidelity-${image.id}`)).toContainText(personLabel);
  await expect(page.getByTestId(`viewer-anchor-${image.id}`)).toHaveText('以封面为锚点');
  await screenshot(page, '70-viewer-person-and-cover-anchor.png');
  await page.getByTestId('viewer-close').click();
  const generatedHistory = await context.messages(project.id);
  const announcement = generatedHistory.find(message => message.role === 'assistant' && /人像一致性/.test(message.text));
  expect(announcement, '任务完成播报应包含一致性摘要').toBeTruthy();
  const announcementLocator = page.getByTestId(`message-${announcement!.id}`);
  await expect(announcementLocator).toHaveText(announcement!.text);
  await screenshot(page, '71-proactive-consistency-summary.png', announcementLocator);

  await page.reload();
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  await expect(referenceCardLocator).toHaveCount(1);
  for (const item of referencesCard.items) for (const tag of item.style_tags) await expect(page.getByTestId(`reference-item-${item.asset_id}`)).toContainText(tag);
  await expect(announcementLocator).toHaveText(announcement!.text);
  await expect(page.getByTestId(`person-fidelity-${image.id}`)).toContainText(personLabel);
  await screenshot(page, '72-consistency-history-restored.png', page.getByTestId(`image-select-${image.id}`));
  await page.getByTestId(`image-select-${image.id}`).click();
  await expect(page.getByTestId(`viewer-anchor-${image.id}`)).toHaveText('以封面为锚点');
  await page.getByTestId('viewer-close').click();

  await page.setViewportSize({ width: 320, height: 844 });
  const imageTile = page.getByTestId(`image-select-${image.id}`);
  await imageTile.scrollIntoViewIfNeeded();
  const garmentBadge = page.getByTestId(`fidelity-${image.id}`);
  const personBadge = page.getByTestId(`person-fidelity-${image.id}`);
  const selection = page.getByTestId(`image-toggle-${image.id}`);
  const [frameBox, garmentBox, personBox, selectionBox] = await Promise.all([imageTile.boundingBox(), garmentBadge.boundingBox(), personBadge.boundingBox(), selection.boundingBox()]);
  expect(frameBox).not.toBeNull();
  expect(garmentBox).not.toBeNull();
  expect(personBox).not.toBeNull();
  expect(selectionBox).not.toBeNull();
  const overlaps = (first: NonNullable<typeof frameBox>, second: NonNullable<typeof frameBox>) => first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;
  expect(overlaps(garmentBox!, personBox!)).toBe(false);
  expect(overlaps(garmentBox!, selectionBox!)).toBe(false);
  expect(overlaps(personBox!, selectionBox!)).toBe(false);
  for (const box of [garmentBox!, personBox!, selectionBox!]) {
    expect(box.x).toBeGreaterThanOrEqual(frameBox!.x);
    expect(box.x + box.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width);
    expect(box.y).toBeGreaterThanOrEqual(frameBox!.y);
    expect(box.y + box.height).toBeLessThanOrEqual(frameBox!.y + frameBox!.height);
  }
  await expect(personBadge.locator('..')).toHaveCSS('pointer-events', 'none');
  await screenshot(page, '76-narrow-screen-badges-and-selection.png', imageTile);
  await page.setViewportSize({ width: 390, height: 844 });

  const stateUrl = `${apiBase}/projects/${project.id}/state`;
  const messagesUrl = `${apiBase}/projects/${project.id}/messages`;
  const withZeroPersonScore = (item: OutfitImage): OutfitImage => item.id === image.id ? { ...item, fidelity: { ...item.fidelity!, person_score: 0 } } : item.id === image.anchor_id ? withoutConsistency(item) : item;
  await page.route(stateUrl, async route => {
    const response = await route.fetch();
    const state = await response.json() as ProjectState;
    state.images = state.images.map(withZeroPersonScore);
    await route.fulfill({ response, json: state });
  });
  await page.route(messagesUrl, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const history = await response.json() as Message[];
    for (const message of history) message.cards = message.cards.map(card => card.type === 'images' ? { ...card, items: card.items.map(withZeroPersonScore) } : card);
    await route.fulfill({ response, json: history });
  });
  await page.reload();
  await expect(page.getByTestId(`person-fidelity-${image.id}`)).toHaveText('人像 0');
  await page.getByTestId(`image-select-${image.id}`).click();
  await expect(page.getByTestId(`viewer-person-fidelity-${image.id}`)).toHaveText('人像 0');
  await expect(page.getByTestId(`viewer-anchor-${image.id}`)).toHaveText('以封面为锚点');
  await screenshot(page, '75-zero-person-score-is-visible.png');
  const gridIds = await page.getByTestId(/^image-select-/).evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')!.replace('image-select-', '')));
  const distance = gridIds.indexOf(image.anchor_id!) - gridIds.indexOf(image.id);
  expect(distance).not.toBe(0);
  for (let offset = 0; offset < Math.abs(distance); offset += 1) await page.getByTestId(distance < 0 ? 'viewer-previous' : 'viewer-next').click();
  await expect(page.getByTestId(/^viewer-person-fidelity-/)).toHaveCount(0);
  await expect(page.getByTestId(/^viewer-anchor-/)).toHaveCount(0);
  for (let offset = 0; offset < Math.abs(distance); offset += 1) await page.getByTestId(distance < 0 ? 'viewer-next' : 'viewer-previous').click();
  await expect(page.getByTestId(`viewer-person-fidelity-${image.id}`)).toHaveText('人像 0');
  await expect(page.getByTestId(`viewer-anchor-${image.id}`)).toHaveText('以封面为锚点');
  await page.getByTestId('viewer-close').click();
  await page.unroute(stateUrl);
  await page.unroute(messagesUrl);

  // Model an older backend by removing only section 12's optional wire fields.
  await page.route(stateUrl, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const legacy = await response.json() as ProjectState;
    legacy.images = legacy.images.map(withoutConsistency);
    delete (legacy as ProjectState & { references?: unknown }).references;
    await route.fulfill({ response, json: legacy });
  });
  await page.route(messagesUrl, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const legacy = await response.json() as Message[];
    for (const message of legacy) message.cards = message.cards.filter(card => card.type !== 'references').map(card => card.type === 'images' ? { ...card, items: card.items.map(withoutConsistency) } : card);
    await route.fulfill({ response, json: legacy });
  });
  await page.route(`${apiBase}/projects/${project.id}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const legacy = await response.json() as Project;
    delete legacy.reference_asset_ids;
    await route.fulfill({ response, json: legacy });
  });
  await page.reload();
  await expect(page.getByTestId('approve-images')).toBeEnabled();
  await expect(page.getByTestId(/^references-card-/)).toHaveCount(0);
  await expect(page.getByTestId(/^person-fidelity-/)).toHaveCount(0);
  await expect(page.getByTestId(`fidelity-${image.id}`)).toContainText(`还原 ${Math.round(image.fidelity!.score)}`);
  await expect(announcementLocator).toHaveText(announcement!.text);
  await screenshot(page, '73-legacy-reference-and-person-fields-hidden.png', page.getByTestId(`image-select-${image.id}`));
  await page.getByTestId(`image-select-${image.id}`).click();
  await expect(page.getByTestId('image-viewer')).toBeVisible();
  await expect(page.getByTestId(/^viewer-person-fidelity-/)).toHaveCount(0);
  await expect(page.getByTestId(/^viewer-anchor-/)).toHaveCount(0);
  await expect(page.getByTestId('viewer-canvas')).toContainText(`还原 ${Math.round(image.fidelity!.score)}`);
  await screenshot(page, '74-legacy-viewer-consistency-hidden.png');
  await page.getByTestId('viewer-close').click();
  expect(context.errors).toEqual([]);
  evidence.flow = { projectId: project.id, referencesLimit: 3, overflowIgnored: true, removeAndReplace: true, selectedReferenceIds, referenceCardId: referencesCard.id, modelId: model.id, uploadKinds: context.uploadKinds, imageId: image.id, anchorId: image.anchor_id, personScore: image.fidelity!.person_score, anchorScore: image.fidelity!.anchor_score, zeroPersonScoreVisible: true, metadataTracksViewerImage: true, narrowScreen: { width: 320, badgesAndSelectionDoNotOverlap: true }, announcement: announcement!.text, announcementUnchanged: true, refreshRestoresMetadata: true, legacyOptionalFieldsHidden: true, legacyFidelityPreserved: true, pageErrors: context.errors };
  await saveEvidence();
});
