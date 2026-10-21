import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

interface Account { token: string; user: { id: string; username: string }; recovery_code: string }
interface Asset { id: string; ownerId: string; url: string; filename?: string; fixture?: string; source: string }
interface Project { id: string; ownerId: string }
interface Job { id: string; ownerId: string }
interface User { id: string; username: string; deleted_at?: string; recovery_code_hash: string | null }
interface Database { users: User[]; assets: Asset[]; projects: Project[]; jobs: Job[]; rate_limits: Record<string, unknown> }
interface State {
  directions: { id: string; preview_url?: string }[];
  images: { id: string; status: string; url?: string; parent_id?: string }[];
  active_jobs: { id: string }[];
}

test('account deletion clears all owned data and files, rejects old credentials, and releases the username without affecting another account', async () => {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const root = path.resolve(import.meta.dirname, '../mock-server/.data/tests');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'account-delete-'));
  const fixturesDir = path.join(dataDir, 'fixtures');
  await mkdir(fixturesDir);
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#6a8c7e' } }).jpeg().toBuffer();
  await writeFile(path.join(fixturesDir, 't-wan-v.jpg'), bytes);
  const instant = Date.parse('2026-10-21T10:16:00.000Z');
  let server: Server;
  let base: string;
  async function start() {
    server = await createMockServer({ dataDir, fixturesDir, clock: () => instant, previewDelayMs: 0, previewStaggerMs: 0, imageDelayMs: 0, imageStaggerMs: 0, editDelayMs: 0, runningDelayMs: 0, tokenDelayMs: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  const request = (route: string, token?: string, method = 'GET', body?: Record<string, unknown>) => fetch(`${base}${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  async function register(username: string) {
    const response = await request('/api/auth/register', undefined, 'POST', { username, password: 'original-password' });
    assert.equal(response.status, 200);
    return response.json() as Promise<Account>;
  }
  async function upload(token: string, kind: string) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'local.jpg');
    form.append('kind', kind);
    const response = await fetch(`${base}/api/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(response.status, 200);
    return response.json() as Promise<Asset>;
  }
  async function project(token: string, assetId: string) {
    const response = await request('/api/projects', token, 'POST', { title: '本地注销验证', brand: '自有服装', brief: '自然街拍', garment_asset_ids: [assetId] });
    assert.equal(response.status, 200);
    return response.json() as Promise<Project>;
  }
  async function send(token: string, projectId: string, body: Record<string, unknown>) {
    const response = await request(`/api/projects/${projectId}/messages`, token, 'POST', body);
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.doesNotMatch(stream, /event: error\n/);
  }
  const state = async (token: string, projectId: string) => (await request(`/api/projects/${projectId}/state`, token)).json() as Promise<State>;
  const database = async () => JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as Database;
  await start();
  try {
    const owner = await register('delete-owner');
    const other = await register('keep-owner');
    const garment = await upload(owner.token, 'garment');
    const orphan = await upload(owner.token, 'model');
    const otherGarment = await upload(other.token, 'garment');
    const ownedProject = await project(owner.token, garment.id);
    const keptProject = await project(other.token, otherGarment.id);
    await send(owner.token, ownedProject.id, { text: '给我几个拍摄方向' });
    const directions = await state(owner.token, ownedProject.id);
    await send(owner.token, ownedProject.id, { action: { type: 'choose_direction', direction_id: directions.directions[0].id } });
    await send(owner.token, ownedProject.id, { action: { type: 'confirm_script' } });
    const images = await state(owner.token, ownedProject.id);
    assert.equal(images.images[0].status, 'succeeded');
    await send(owner.token, ownedProject.id, { action: { type: 'edit_image', image_id: images.images[0].id, instruction: '背景调暖', region: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } } });
    const edited = await state(owner.token, ownedProject.id);
    assert.equal(edited.active_jobs.length, 0);
    await send(other.token, keptProject.id, { text: '给我几个拍摄方向' });
    await state(other.token, keptProject.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await request('/api/auth/recover', undefined, 'POST', { username: 'delete-owner', recovery_code: 'AAAA-BBBB-CCCC', new_password: 'changed-password' })).status, 400);
    }
    const before = await database();
    const ownedAssets = before.assets.filter((asset) => asset.ownerId === owner.user.id);
    const ownerFiles = ownedAssets.filter((asset) => asset.filename && !asset.fixture);
    assert.ok(ownerFiles.length >= 3, 'uploads and generated edit files exist before deletion');
    assert.ok(ownerFiles.some((asset) => asset.source === 'generated'));
    for (const asset of ownerFiles) assert.equal((await stat(path.join(dataDir, 'uploads', asset.filename!))).isFile(), true);
    assert.ok(before.jobs.some((job) => job.ownerId === owner.user.id));
    assert.ok(before.jobs.some((job) => job.ownerId === other.user.id));
    const ownedUrls = [garment.url, orphan.url, ...edited.images.flatMap((image) => image.url ? [image.url] : []), ...edited.directions.flatMap((direction) => direction.preview_url ? [direction.preview_url] : [])];
    for (const url of ownedUrls) assert.equal((await fetch(url)).status, 200);
    const wrong = await request('/api/me', owner.token, 'DELETE', { password: 'wrong-password' });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json() as { error: { code: string } }).error.code, 'INVALID_PASSWORD');
    assert.deepEqual(await database(), before);
    assert.equal((await request('/api/me', owner.token)).status, 200);
    assert.equal((await request('/api/me', undefined, 'DELETE', { password: 'original-password' })).status, 401);
    const deleted = await request('/api/me', owner.token, 'DELETE', { password: 'original-password' });
    assert.equal(deleted.status, 204);
    const after = await database();
    const deletedUser = after.users.find((user) => user.id === owner.user.id)!;
    assert.equal(deletedUser.deleted_at, new Date(instant).toISOString());
    assert.equal(deletedUser.username, `deleted-${owner.user.id.slice(0, 8)}`);
    assert.equal(deletedUser.recovery_code_hash, null);
    assert.deepEqual(after.rate_limits, {});
    assert.equal(after.projects.some((item) => item.ownerId === owner.user.id), false);
    assert.equal(after.jobs.some((item) => item.ownerId === owner.user.id), false);
    assert.equal(after.assets.some((item) => item.ownerId === owner.user.id), false);
    for (const asset of ownerFiles) await assert.rejects(stat(path.join(dataDir, 'uploads', asset.filename!)), { code: 'ENOENT' });
    for (const url of ownedUrls) assert.equal((await fetch(url)).status, 404);
    assert.deepEqual(after.assets, before.assets.filter((asset) => asset.ownerId === other.user.id || asset.ownerId === null));
    assert.deepEqual(after.projects, before.projects.filter((item) => item.ownerId === other.user.id));
    assert.deepEqual(after.jobs, before.jobs.filter((item) => item.ownerId === other.user.id));
    assert.equal((await fetch(otherGarment.url)).status, 200);
    assert.equal((await stat(path.join(fixturesDir, 't-wan-v.jpg'))).isFile(), true);
    assert.equal((await request(`/api/projects/${ownedProject.id}`, other.token)).status, 404);
    assert.equal((await request(`/api/projects/${keptProject.id}`, other.token)).status, 200);
    assert.equal((await request('/api/me', owner.token)).status, 401);
    for (const username of ['delete-owner', deletedUser.username]) {
      assert.equal((await request('/api/auth/login', undefined, 'POST', { username, password: 'original-password' })).status, 401);
      const recovered = await request('/api/auth/recover', undefined, 'POST', { username, recovery_code: owner.recovery_code, new_password: 'changed-password' });
      assert.equal(recovered.status, 400);
      assert.equal((await recovered.json() as { error: { code: string } }).error.code, 'RECOVERY_FAILED');
    }
    const replacement = await register('delete-owner');
    assert.notEqual(replacement.user.id, owner.user.id);
    assert.deepEqual(await (await request('/api/projects', replacement.token)).json(), []);
    const profile = await (await request('/api/me', replacement.token)).json() as { profile: { model_asset_ids: string[] } };
    assert.deepEqual(profile.profile.model_asset_ids, []);
    assert.equal((await request('/api/auth/recover', undefined, 'POST', { username: 'delete-owner', recovery_code: replacement.recovery_code, new_password: 'changed-password' })).status, 200);
    await close();
    await start();
    assert.equal((await request('/api/me', owner.token)).status, 401);
    assert.equal((await request(`/api/projects/${keptProject.id}`, other.token)).status, 200);
    assert.deepEqual((await database()).users.find((user) => user.id === owner.user.id), deletedUser);
  } finally {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
