import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { ApiClient } from '../src/api/client';
import type { ModelCard } from '../src/lib/models';

async function setup(lowPersonScoreOnce = false) {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'outfit-model-test-'));
  const fixturesDir = path.join(dataDir, 'fixtures');
  await mkdir(fixturesDir);
  const bytes = await sharp({ create: { width: 64, height: 96, channels: 3, background: '#ddd4c3' } }).jpeg().toBuffer();
  await writeFile(path.join(fixturesDir, 't-wan-v.jpg'), bytes);
  let instant = Date.now();
  let server: Server;
  let base = '';
  async function start() {
    server = await createMockServer({ dataDir, fixturesDir, clock: () => instant, previewDelayMs: 20, previewStaggerMs: 0, imageDelayMs: 20, imageStaggerMs: 0, editDelayMs: 20, identityDelayMs: 100, runningDelayMs: 10, tokenDelayMs: 0, workerIntervalMs: 3600000, lowPersonScoreOnce });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  async function closeServer() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await start();
  async function register(username: string) {
    const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'local-model-test-password' }) });
    assert.equal(response.status, 200);
    const account = await response.json() as { token: string; user: { id: string } };
    return { ...account, api: new ApiClient({ baseUrl: base, token: account.token }) };
  }
  const upload = (api: ApiClient, kind: 'model' | 'garment') => api.uploadAsset(new File([bytes], `${kind}.jpg`, { type: 'image/jpeg' }), kind);
  return {
    register, upload,
    send: async (projectId: string, token: string, body: object) => {
      const response = await fetch(`${base}/api/projects/${projectId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /event: error/);
    },
    advance: (delta = 200) => { instant += delta; },
    database: async () => JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as {
      models: ModelCard[];
      assets: { id: string; ownerId: string | null }[];
      jobs: { id: string; imageId?: string; kind: string; directionId?: string; project_id: string | null; reference_asset_ids: string[]; result_asset_id: string; auto_fix?: boolean; auto_fix_for?: string; best_person_asset_id?: string }[];
      projects: { id: string; modelId: string; modelAssetId: string }[];
    },
    restart: async () => { await closeServer(); await start(); return base; },
    close: async () => { await closeServer(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('mock model contract migrates photos, seeds presets, confirms identity once and survives restart', async () => {
  const app = await setup();
  try {
    const owner = await app.register('model-owner');
    const other = await app.register('model-other');
    const before = await owner.api.myModels();
    assert.equal(before.total, 3);
    assert.ok(before.items.every(model => model.kind === 'preset' && model.missing.length === 0));
    assert.equal((await fetch(before.items[0].face!.url)).status, 200);
    const face = await app.upload(owner.api, 'model');
    await owner.api.patchMe({ profile: { model_asset_ids: [face.id] } });
    const migrated = await owner.api.myModels();
    assert.equal(migrated.total, 4);
    assert.equal(migrated.items.find(model => model.kind === 'own')?.missing.length, 3);
    const input = { asset_ids: [face.id], name: '本人身份卡' };
    const quote = await owner.api.quoteIdentity(input);
    assert.equal(quote.generated_count, 3);
    assert.ok(quote.estimate_points >= 15);
    await assert.rejects(other.api.createIdentity({ ...input, confirmation_token: quote.confirmation_token }));
    const card = await owner.api.createIdentity({ ...input, confirmation_token: quote.confirmation_token });
    const duplicate = await owner.api.createIdentity({ ...input, confirmation_token: quote.confirmation_token });
    assert.equal(card.id, duplicate.id);
    assert.equal(card.status, 'queued');
    assert.equal((await owner.api.job(card.job_id!)).kind, 'identity');
    app.advance(30);
    assert.equal((await owner.api.myModels()).items.find(model => model.id === card.id)?.status, 'building');
    app.advance();
    const ready = (await owner.api.myModels()).items.find(model => model.id === card.id)!;
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.missing, []);
    assert.equal(ready.sheet_asset_ids.length, 4);
    assert.ok(ready.identity_text.includes('肤色'));
    const database = await app.database();
    assert.equal(database.jobs.filter(job => job.kind === 'identity').length, 1);
    assert.equal(database.assets.filter(asset => asset.ownerId === owner.user.id).length, 4);
    assert.equal((await other.api.myModels()).total, 3);
    await owner.api.deleteModel(card.id);
    const base = await app.restart();
    const restored = new ApiClient({ baseUrl: base, token: owner.token });
    const after = await restored.myModels();
    assert.equal(after.items.filter(model => model.kind === 'preset').length, 3);
    assert.equal(after.items.some(model => model.id === card.id), false);
  } finally { await app.close(); }
});

test('preset model creates image jobs without a person upload and keeps identity, clothes, cover order', async () => {
  const app = await setup(true);
  try {
    const owner = await app.register('model-shoot');
    const garment = await app.upload(owner.api, 'garment');
    const model = (await owner.api.myModels()).items.find(item => item.name === '衣序模特 A')!;
    const project = await owner.api.createProject({ title: '预置出片', brand: '个人', brief: '自然窗光', garment_asset_ids: [garment.id], model_id: model.id, model_asset_id: 'ignored-invalid' });
    const database = await app.database();
    assert.equal(database.projects[0].modelId, model.id);
    assert.equal(database.projects[0].modelAssetId, model.face_asset_id);
    assert.equal(database.assets.filter(asset => asset.ownerId === owner.user.id).length, 1);
    const send = (body: object) => app.send(project.id, owner.token, body);
    await send({ text: '给几个方向' });
    app.advance();
    const directions = await owner.api.state(project.id);
    await send({ action: { type: 'choose_direction', direction_id: directions.directions[0].id } });
    await send({ action: { type: 'confirm_script' } });
    for (let index = 0; index < 8; index += 1) { app.advance(); await owner.api.state(project.id); }
    const state = await owner.api.state(project.id);
    assert.ok(state.images.every(image => image.status === 'succeeded'));
    const originalCover = state.images.find(image => image.shot_id === 'shot_1' && image.version === 1)!;
    assert.equal(originalCover.fidelity?.person_score, 55);
    const fixedCover = state.images.find(image => image.parent_id === originalCover.id)!;
    assert.equal(fixedCover.fidelity?.person_score, 92);
    const finalDb = await app.database();
    const originalJobs = finalDb.jobs.filter(job => job.kind === 'image' && !job.directionId);
    // 封面默认带上第一张灵感图：顺序是 衣服 → 灵感图 → 人物身份卡（三张）。
    const coverRefs = originalJobs[0].reference_asset_ids;
    assert.equal(coverRefs[0], garment.id);
    assert.equal(coverRefs.length, 5);
    assert.deepEqual(coverRefs.slice(-3), model.sheet_asset_ids.slice(0, 3));
    const fixedJob = finalDb.jobs.find(job => job.imageId === fixedCover.id)!;
    assert.equal(fixedJob.auto_fix, true);
    assert.ok(fixedJob.best_person_asset_id);
    assert.ok(fixedJob.reference_asset_ids.includes(model.face_asset_id!));
    for (const job of originalJobs.slice(1)) assert.deepEqual(job.reference_asset_ids, [...model.sheet_asset_ids.slice(0, 3), garment.id, fixedJob.result_asset_id]);
    const messages = await owner.api.messages(project.id);
    assert.ok(messages.some(message => message.text.includes('人像一致性 92')));
    assert.equal(finalDb.jobs.filter(job => job.auto_fix_for === originalJobs[0].id).length, 1);
  } finally { await app.close(); }
});
