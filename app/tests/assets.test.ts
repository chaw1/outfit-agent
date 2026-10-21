import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { MockServerOptions } from '../mock-server/index.mjs';

interface Asset { id: string; kind: string; url: string; source: string; parent_id?: string; analysis?: { name: string }; name?: string; in_profile: boolean; project_id: string | null; project_title: string | null; created_at: string }
interface User { id: string; profile: { model_asset_ids: string[] } }
interface Saved { asset: Asset; user: User }
interface State { images: { id: string; status: string; url: string; parent_id?: string }[]; directions: { id: string }[] }

async function setup(options: MockServerOptions = {}) {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const root = path.resolve(import.meta.dirname, '../mock-server/.data/tests');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'assets-'));
  const fixturesDir = path.join(dataDir, 'fixtures');
  await mkdir(fixturesDir);
  const bytes = await sharp({ create: { width: 40, height: 48, channels: 3, background: '#6a8c7e' } }).jpeg().toBuffer();
  await writeFile(path.join(fixturesDir, 't-wan-v.jpg'), bytes);
  let tick = 0;
  const server = await createMockServer({ dataDir, fixturesDir, clock: () => Date.parse('2026-10-21T08:00:00Z') + tick++, previewDelayMs: 0, previewStaggerMs: 0, imageDelayMs: 0, imageStaggerMs: 0, editDelayMs: 0, runningDelayMs: 0, tokenDelayMs: 0, ...options });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, token?: string, method = 'GET', body?: Record<string, unknown>) => fetch(`${base}/api${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  async function register(username: string) {
    const response = await request('/auth/register', undefined, 'POST', { username, password: 'local-assets-password' });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ token: string; user: User }>;
  }
  async function upload(token: string, kind = 'garment') {
    const form = new FormData(); form.append('kind', kind); form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'test.jpg');
    const response = await fetch(`${base}/api/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(response.status, 200); return response.json() as Promise<Asset>;
  }
  async function create(token: string, id: string, title = '操场那组') {
    const response = await request('/projects', token, 'POST', { title, brand: '本人服装', brief: '自然街拍', garment_asset_ids: [id] });
    assert.equal(response.status, 200); return response.json() as Promise<{ id: string }>;
  }
  async function send(token: string, id: string, body: Record<string, unknown>) {
    const response = await request(`/projects/${id}/messages`, token, 'POST', body);
    assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /event: error\n/);
  }
  const state = async (token: string, id: string) => (await request(`/projects/${id}/state`, token)).json() as Promise<State>;
  const library = async (token: string, kind: string, page = '') => (await request(`/me/assets?kind=${kind}${page}`, token)).json() as Promise<{ items: Asset[]; total: number }>;
  const database = async () => JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8'));
  async function close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(dataDir, { recursive: true, force: true }); }
  return { request, register, upload, create, send, state, library, database, dataDir, close };
}

test('material library copies owned finished images, keeps idempotency and default order, reuses garments and preserves saved models after project deletion', async () => {
  const app = await setup();
  try {
    const owner = await app.register('library-owner'); const other = await app.register('library-other');
    const garment = await app.upload(owner.token); const unused = await app.upload(owner.token); const otherGarment = await app.upload(other.token);
    const project = await app.create(owner.token, garment.id);
    const reused = await app.create(owner.token, garment.id, '复用这件衣服');
    await app.send(owner.token, project.id, { text: '给几个方向' });
    const directions = await app.state(owner.token, project.id);
    await app.send(owner.token, project.id, { action: { type: 'choose_direction', direction_id: directions.directions[0].id } });
    await app.send(owner.token, project.id, { action: { type: 'confirm_script' } });
    const originals = await app.state(owner.token, project.id);
    assert.equal(originals.images[0].status, 'succeeded');
    await app.send(owner.token, project.id, { action: { type: 'edit_image', image_id: originals.images[0].id, instruction: '背景暖一点' } });
    const edited = await app.state(owner.token, project.id);
    const imageList = await app.library(owner.token, 'image');
    assert.equal(imageList.total, edited.images.filter(image => image.status === 'succeeded').length);
    assert.ok(imageList.items.length > originals.images.length, 'edited versions belong to the library');
    assert.ok(imageList.items.every(item => item.kind === 'image' && item.id.startsWith('asset_') && item.project_id === project.id && item.project_title === '操场那组' && item.in_profile === false));
    const sourceId = new URL(originals.images[0].url).pathname.split('/').at(-1)!;
    const [firstResponse, concurrentResponse] = await Promise.all([app.request('/me/models/from-image', owner.token, 'POST', { image_id: originals.images[0].id }), app.request('/me/models/from-image', owner.token, 'POST', { image_id: sourceId })]);
    assert.equal(firstResponse.status, 200); assert.equal(concurrentResponse.status, 200);
    const saved = await firstResponse.json() as Saved; const concurrent = await concurrentResponse.json() as Saved;
    assert.equal(saved.asset.id, concurrent.asset.id); assert.equal(saved.asset.parent_id, sourceId); assert.equal(saved.asset.source, 'generated'); assert.equal(saved.asset.analysis?.name, '操场那组');
    const renamed = await (await app.request('/me/models/from-image', owner.token, 'POST', { image_id: originals.images[0].id, name: '重复名称不覆盖' })).json() as Saved;
    assert.equal(renamed.asset.id, saved.asset.id); assert.equal(renamed.asset.analysis?.name, '操场那组');
    assert.deepEqual(saved.user.profile.model_asset_ids, [saved.asset.id]);
    assert.equal((await app.request('/me/models/from-image', other.token, 'POST', { image_id: originals.images[0].id })).status, 404);
    const preview = directions.directions[0] as { id: string; preview_url?: string };
    if (preview.preview_url) assert.equal((await app.request('/me/models/from-image', owner.token, 'POST', { image_id: new URL(preview.preview_url).pathname.split('/').at(-1) })).status, 404);
    const second = await (await app.request('/me/models/from-image', owner.token, 'POST', { image_id: originals.images[1].id, name: '另一位她' })).json() as Saved;
    assert.equal(second.asset.analysis?.name, '另一位她');
    assert.equal((await app.request('/me', owner.token, 'PATCH', { profile: { model_asset_ids: [second.asset.id] } })).status, 200);
    const restored = await (await app.request('/me/models/from-image', owner.token, 'POST', { image_id: originals.images[0].id })).json() as Saved;
    assert.equal(restored.asset.id, saved.asset.id);
    assert.deepEqual(restored.user.profile.model_asset_ids, [second.asset.id, saved.asset.id]);
    const defaults = await app.request('/me', owner.token, 'PATCH', { profile: { model_asset_ids: [second.asset.id, saved.asset.id] } });
    assert.equal(defaults.status, 200);
    const modelList = await app.library(owner.token, 'model', '&limit=1&offset=0');
    assert.equal(modelList.total, 2); assert.equal(modelList.items.length, 1); assert.equal(modelList.items[0].id, second.asset.id); assert.equal(modelList.items[0].name, '另一位她'); assert.equal(modelList.items[0].in_profile, true);
    assert.equal((await app.library(owner.token, 'model', '&limit=1&offset=1')).items[0].id, saved.asset.id);
    assert.equal((await app.library(other.token, 'model')).total, 0);
    assert.equal((await app.library(other.token, 'garment')).items[0].id, otherGarment.id);
    const withDefault = await app.create(owner.token, garment.id, '默认出镜');
    assert.equal((await app.database()).projects.find((item: { id: string }) => item.id === withDefault.id).modelAssetId, second.asset.id);
    assert.equal((await app.request(`/me/assets/${garment.id}`, other.token, 'DELETE')).status, 404);
    const blocked = await app.request(`/me/assets/${garment.id}`, owner.token, 'DELETE');
    assert.equal(blocked.status, 409); assert.match((await blocked.json()).error.message, /操场那组.*复用这件衣服.*默认出镜/);
    assert.equal((await app.request(`/me/assets/${sourceId}`, owner.token, 'DELETE')).status, 409);
    assert.equal((await app.request(`/me/assets/${unused.id}`, owner.token, 'DELETE')).status, 204);
    assert.equal((await app.library(owner.token, 'garment')).total, 1);
    const before = await app.database(); const copy = before.assets.find((item: { id: string }) => item.id === saved.asset.id);
    assert.deepEqual(await readFile(path.join(app.dataDir, 'uploads', copy.filename)), Buffer.from(await (await fetch(originals.images[0].url)).arrayBuffer()));
    assert.equal((await app.request(`/projects/${project.id}`, owner.token, 'DELETE')).status, 204);
    assert.equal((await fetch(saved.asset.url)).status, 200); assert.equal((await app.library(owner.token, 'model')).total, 2); assert.equal((await app.library(owner.token, 'image')).total, 0);
    assert.equal((await app.request(`/me/assets/${saved.asset.id}`, owner.token, 'DELETE')).status, 204);
    await assert.rejects(stat(path.join(app.dataDir, 'uploads', copy.filename)), { code: 'ENOENT' });
    assert.deepEqual((await (await app.request('/me', owner.token)).json()).profile.model_asset_ids, [second.asset.id]);
    const remainingCopy = (await app.database()).assets.find((item: { id: string }) => item.id === second.asset.id);
    assert.equal((await app.request('/me', owner.token, 'DELETE', { password: 'local-assets-password' })).status, 204);
    await assert.rejects(stat(path.join(app.dataDir, 'uploads', remainingCopy.filename)), { code: 'ENOENT' });
    assert.equal((await fetch(second.asset.url)).status, 404);
    assert.equal((await app.request(`/projects/${reused.id}`, other.token)).status, 404);
    assert.equal((await fetch(otherGarment.url)).status, 200);
  } finally { await app.close(); }
});

test('saving a new model at the profile limit returns Chinese 422; retrying an existing saved image stays idempotent', async () => {
  const app = await setup();
  try {
    const owner = await app.register('limit-owner'); const garment = await app.upload(owner.token); const project = await app.create(owner.token, garment.id);
    await app.send(owner.token, project.id, { text: '给几个方向' });
    await app.send(owner.token, project.id, { action: { type: 'choose_direction', direction_id: (await app.state(owner.token, project.id)).directions[0].id } });
    await app.send(owner.token, project.id, { action: { type: 'confirm_script' } });
    const images = (await app.state(owner.token, project.id)).images;
    const saved = await (await app.request('/me/models/from-image', owner.token, 'POST', { image_id: images[0].id })).json() as Saved;
    const ids = [saved.asset.id];
    for (let index = 0; index < 19; index++) ids.push((await app.upload(owner.token, 'model')).id);
    assert.equal((await app.request('/me', owner.token, 'PATCH', { profile: { model_asset_ids: ids } })).status, 200);
    const limit = await app.request('/me/models/from-image', owner.token, 'POST', { image_id: images[1].id });
    assert.equal(limit.status, 422); assert.match((await limit.json()).error.message, /20.*删除/);
    const retry = await app.request('/me/models/from-image', owner.token, 'POST', { image_id: images[0].id });
    assert.equal(retry.status, 200); assert.equal((await retry.json() as Saved).asset.id, saved.asset.id);
    assert.equal((await app.library(owner.token, 'model')).total, 20);
    const extra = await app.upload(owner.token, 'model');
    assert.equal((await app.request('/me', owner.token, 'PATCH', { profile: { model_asset_ids: [...ids.slice(1), extra.id] } })).status, 200);
    assert.equal((await app.request('/me/models/from-image', owner.token, 'POST', { image_id: images[0].id })).status, 422, 'restoring an existing copy also respects the profile limit');
    for (const query of ['kind=invalid', 'kind=model&offset=-1', 'kind=model&limit=0']) assert.equal((await app.request(`/me/assets?${query}`, owner.token)).status, 422);
  } finally { await app.close(); }
});

for (const options of [{ legacyAssets: true }, { legacyProfile: 'old-fields' as const }, { legacyProfile: 'missing' as const }]) {
  test(`older service hides the material library: ${JSON.stringify(options)}`, async () => {
    const app = await setup(options);
    try {
      const owner = await app.register('legacy-owner');
      assert.equal((await app.request('/me/assets?kind=model', owner.token)).status, 404);
      assert.equal((await app.request('/me/models/from-image', owner.token, 'POST', { image_id: 'missing' })).status, 404);
      assert.equal((await app.request('/me/assets/missing', owner.token, 'DELETE')).status, 404);
      assert.equal((await app.request('/projects', owner.token)).status, 200);
    } finally { await app.close(); }
  });
}
