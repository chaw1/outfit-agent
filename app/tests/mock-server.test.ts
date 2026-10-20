import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import type { MockServerOptions } from '../mock-server/index.mjs';

interface User { id: string; username: string; nickname: string; created_at: string }
interface Account { token: string; user: User }
interface Asset { id: string; url: string; width: number; height: number; source: string; mime: string }
interface Project { id: string; stage: string; cover_url?: string }
interface Image { id: string; shot_id: string; status: string; version: number; parent_id?: string; url?: string }
interface Job { id: string; kind: string; status: string; result_asset_id?: string; url?: string }
interface State {
  stage: string;
  images: Image[];
  directions: { id: string }[];
  garments: { asset_id: string; url: string }[];
  script?: { status: string; cover: { scene: string }; shots: { scene: string; pose: string; caption: string }[] };
  note?: { image_ids: string[]; title: string; body: string; tags: string[] };
  video?: { status: string; url?: string };
  active_jobs: Job[];
  pending_action: { type: string } | null;
}
interface Card { id: string; type: string; items?: Image[]; options?: { id: string }[]; status?: string; url?: string; poster_url?: string }
interface Message { id: string; role: string; text: string; cards: Card[]; action?: Record<string, unknown> }
interface Event { type: string; data: Record<string, unknown> }

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const testRoot = path.resolve(import.meta.dirname, '../mock-server/.data/tests');
let nextPort = 19410;
async function temporaryData(prefix: string) {
  await mkdir(testRoot, { recursive: true });
  return mkdtemp(path.join(testRoot, prefix));
}

async function startServer(dataDir: string, extra: MockServerOptions = {}) {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const server = await createMockServer({ dataDir, imageDelayMs: 200, imageStaggerMs: 0, editDelayMs: 180, videoDelayMs: 200, runningDelayMs: 30, tokenDelayMs: 0, ...extra });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const port = nextPort++;
    if (nextPort > 19499) nextPort = 19410;
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve(); };
        const onError = (error: NodeJS.ErrnoException) => { server.off('listening', onListening); reject(error); };
        server.once('error', onError); server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 89) throw error;
    }
  }
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function request<T>(base: string, route: string, options: { token?: string; method?: string; body?: Record<string, unknown> | FormData } = {}) {
  const form = options.body instanceof FormData;
  const response = await fetch(`${base}${route}`, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(!form && options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? form ? options.body as FormData : JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { response, body: (text ? JSON.parse(text) : undefined) as T };
}
async function send(base: string, projectId: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/projects/${projectId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const stream = await response.text();
  return stream.split('\n\n').filter(Boolean).map((block): Event => {
    const lines = block.split('\n');
    return { type: lines.find((line) => line.startsWith('event: '))!.slice(7), data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown> };
  });
}
async function register(base: string, username: string) {
  const result = await request<Account>(base, '/api/auth/register', { body: { username, password: 'demo-password', nickname: '穿搭博主' } });
  assert.equal(result.response.status, 200);
  return result.body;
}
async function upload(base: string, token: string, kind = 'garment') {
  const data = await readFile(path.resolve(import.meta.dirname, '../../docs/spike/inputs.jpg'));
  const form = new FormData();
  form.append('file', new Blob([data], { type: 'image/jpeg' }), 'garment.jpg');
  form.append('kind', kind);
  const result = await request<Asset>(base, '/api/assets', { token, body: form });
  assert.equal(result.response.status, 200);
  assert.ok(result.body.width > 0 && result.body.height > 0);
  return result.body;
}

test('mock authentication validates credentials, stores bcrypt, and isolates user assets/projects', async () => {
  const dataDir = await temporaryData('outfit-mock-auth-');
  const { server, base } = await startServer(dataDir);
  try {
    assert.equal((await request(base, '/api/health')).response.status, 401);
    assert.equal((await request(base, '/api/me')).response.status, 401);
    assert.equal((await request(base, '/api/me', { token: 'invalid' })).response.status, 401);
    assert.equal((await request(base, '/api/auth/register', { body: { username: 'ab', password: 'long-enough' } })).response.status, 400);
    assert.equal((await request(base, '/api/auth/register', { body: { username: 'alice', password: 'short' } })).response.status, 400);
    const alice = await register(base, 'alice');
    const health = await request<{ ok: boolean; providers: { mock: boolean } }>(base, '/api/health', { token: alice.token });
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.providers.mock, true);
    const bob = await register(base, 'bob');
    const me = await request<User>(base, '/api/me', { token: alice.token });
    assert.equal(me.body.id, alice.user.id);
    assert.equal(me.body.nickname, '穿搭博主');
    assert.equal((await request(base, '/api/auth/register', { body: { username: 'ALICE', password: 'demo-password' } })).response.status, 409);
    assert.equal((await request(base, '/api/auth/login', { body: { username: 'alice', password: 'wrong-password' } })).response.status, 401);
    assert.equal((await request(base, '/api/auth/login', { body: { username: 'alice', password: 'demo-password' } })).response.status, 200);
    const asset = await upload(base, alice.token);
    const projectInput = { title: '周末穿搭', brand: '日常品牌', brief: '自然的街头穿搭', garment_asset_ids: [asset.id] };
    assert.equal((await request(base, '/api/projects', { token: bob.token, body: projectInput })).response.status, 400);
    const project = await request<Project>(base, '/api/projects', { token: alice.token, body: projectInput });
    assert.equal(project.response.status, 200);
    assert.equal((await request(base, `/api/projects/${project.body.id}`, { token: bob.token })).response.status, 404);
    assert.equal((await request(base, `/api/projects/${project.body.id}/state`, { token: bob.token })).response.status, 404);
    assert.equal((await request(base, `/api/projects/${project.body.id}/messages`, { token: bob.token })).response.status, 404);
    const projects = await request<Project[]>(base, '/api/projects', { token: bob.token });
    assert.deepEqual(projects.body, []);
    const media = await fetch(asset.url);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/jpeg');
    const tampered = new URL(asset.url);
    tampered.searchParams.set('sig', 'invalid');
    assert.equal((await fetch(tampered)).status, 403);
    const stored = await readFile(path.join(dataDir, 'db.json'), 'utf8');
    assert.match(stored, /\$2[aby]\$10\$/);
    assert.ok(!stored.includes('demo-password'));
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('full mock workflow streams stable cards, advances jobs, keeps versions/order, plays video, and resumes after restart', async () => {
  const dataDir = await temporaryData('outfit-mock-flow-');
  let { server, base } = await startServer(dataDir);
  try {
    const account = await register(base, 'creator');
    const other = await register(base, 'another');
    const asset = await upload(base, account.token);
    const model = await upload(base, account.token, 'model');
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '一周穿搭合作', brand: '木棉', brief: '轻松舒适的城市漫步', garment_asset_ids: [asset.id], model_asset_id: model.id } })).body;
    const state = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    assert.equal((await state()).stage, 'brief');
    const premature = await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    assert.equal(premature[0].type, 'error');
    assert.equal((await state()).stage, 'brief');
    const first = await send(base, project.id, account.token, { text: '帮我做一篇周末穿搭笔记' });
    assert.ok(first.some((event) => event.type === 'token' && event.data.delta));
    assert.deepEqual(first.filter((event) => event.type === 'card').map((event) => event.data.type), ['garments', 'directions']);
    assert.equal(first.at(-1)?.type, 'done');
    const directionsId = first.find((event) => event.type === 'card' && event.data.type === 'directions')!.data.id;
    const revised = await send(base, project.id, account.token, { text: '再松弛一点' });
    assert.equal(revised.find((event) => event.type === 'card' && event.data.type === 'directions')!.data.id, directionsId);
    let current = await state();
    assert.equal(current.pending_action?.type, 'choose_direction');
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: current.directions[0].id } });
    assert.equal((await state()).script?.status, 'draft');
    await send(base, project.id, account.token, { text: '封面要更自然一点' });
    const confirmed = await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    const initialJobs = confirmed.filter((event) => event.type === 'job');
    assert.equal(initialJobs.length, 3);
    assert.ok(initialJobs.every((event) => event.data.status === 'queued'));
    assert.equal((await request(base, `/api/jobs/${initialJobs[0].data.id}`, { token: other.token })).response.status, 404);
    await wait(60);
    current = await state();
    assert.equal(current.stage, 'images');
    assert.equal(current.script?.status, 'confirmed');
    assert.ok(current.images.every((image) => image.status === 'running'));
    await closeServer(server);
    ({ server, base } = await startServer(dataDir));
    assert.equal((await state()).active_jobs.length, 3);
    await wait(190);
    current = await state();
    assert.ok(current.images.every((image) => image.status === 'succeeded'));
    assert.deepEqual(current.active_jobs, []);
    const original = current.images[0];
    assert.equal((await fetch(original.url!)).status, 200);
    const edit = await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: original.id, instruction: '把衬衫塞进裤腰，背景更明亮' } });
    assert.equal(edit.find((event) => event.type === 'job')?.data.kind, 'edit');
    current = await state();
    assert.equal(current.images.length, 4);
    const version = current.images.find((image) => image.parent_id === original.id)!;
    assert.equal(version.version, 2);
    assert.equal(version.shot_id, original.shot_id);
    assert.equal(current.images.find((image) => image.id === original.id)?.status, 'succeeded');
    const invalidApprove = await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: [version.id] } });
    assert.equal(invalidApprove[0].type, 'error');
    await wait(220);
    current = await state();
    assert.equal(current.images.find((image) => image.id === version.id)?.status, 'succeeded');
    const imageOrder = [version.id, current.images[2].id, current.images[1].id];
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: imageOrder } });
    current = await state();
    assert.deepEqual(current.note?.image_ids, imageOrder);
    assert.equal(current.stage, 'note');
    assert.equal(current.pending_action?.type, 'confirm_video');
    const videoEvents = await send(base, project.id, account.token, { action: { type: 'confirm_video', image_id: version.id } });
    assert.ok(videoEvents.some((event) => event.type === 'card' && event.data.type === 'video'));
    assert.equal((await state()).video?.status, 'queued');
    await wait(60);
    assert.equal((await state()).video?.status, 'running');
    await wait(190);
    current = await state();
    assert.equal(current.stage, 'done');
    assert.equal(current.video?.status, 'succeeded');
    assert.deepEqual(current.active_jobs, []);
    const video = await fetch(current.video!.url!, { headers: { Range: 'bytes=0-63' } });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.match(video.headers.get('content-range') || '', /^bytes 0-63\/\d+$/);
    const videoBytes = Buffer.from(await video.arrayBuffer());
    assert.equal(videoBytes.length, 64);
    assert.match(videoBytes.toString('ascii', 0, 32), /ftyp/);
    const suffix = await fetch(current.video!.url!, { headers: { Range: 'bytes=-32' } });
    assert.equal(suffix.status, 206);
    assert.equal((await suffix.arrayBuffer()).byteLength, 32);
    const job = (await request<Job>(base, `/api/jobs/${initialJobs[0].data.id}`, { token: account.token })).body;
    assert.equal(job.status, 'succeeded');
    assert.ok(job.result_asset_id && job.url);
    const messages = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    const imageCards = messages.flatMap((message) => message.cards).filter((item) => item.type === 'images');
    assert.ok(imageCards.length >= 2);
    assert.equal(new Set(imageCards.map((item) => item.id)).size, 1);
    assert.ok(imageCards.every((item) => item.items?.length === 4 && item.items.every((image) => image.status === 'succeeded')));
    await closeServer(server);
    ({ server, base } = await startServer(dataDir));
    assert.equal((await request<User>(base, '/api/me', { token: account.token })).body.id, account.user.id);
    const restored = await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token });
    assert.equal(restored.body.stage, 'done');
    assert.deepEqual(restored.body.note?.image_ids, imageOrder);
    assert.equal((await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body.length, messages.length);
    assert.equal((await request(base, `/api/projects/${project.id}`, { token: account.token, method: 'DELETE' })).response.status, 204);
    assert.equal((await request(base, `/api/projects/${project.id}`, { token: account.token })).response.status, 404);
    assert.equal((await request(base, `/api/jobs/${initialJobs[0].data.id}`, { token: account.token })).response.status, 404);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('mock revisions preserve drafts, missing media fails/retries, refreshed links survive expiry and state rollback', async () => {
  const dataDir = await temporaryData('outfit-mock-recovery-');
  const fixturesDir = path.join(dataDir, 'fixtures');
  await mkdir(fixturesDir);
  let time = Date.now();
  const { server, base } = await startServer(dataDir, { fixturesDir, clock: () => time });
  try {
    const account = await register(base, 'recovery');
    const asset = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '通勤合作', brand: '棉与', brief: '想做一篇穿搭笔记', garment_asset_ids: [asset.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    assert.equal((await getState()).garments[0].asset_id, asset.id);
    assert.deepEqual(Buffer.from(await (await fetch(asset.url)).arrayBuffer()), await readFile(path.resolve(import.meta.dirname, '../../docs/spike/inputs.jpg')));
    const malformed = await fetch(`${base}/api/projects/${project.id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }, body: '{invalid' });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { code: string } }).error.code, 'INVALID_JSON');
    assert.equal((await request(base, '/api/projects/%ZZ', { token: account.token })).response.status, 400);
    assert.equal((await send(base, project.id, account.token, { text: 3 }))[0].data.code, 'INVALID_MESSAGE');
    await send(base, project.id, account.token, { text: '换成通勤，舒服随性一点' });
    let state = await getState();
    assert.equal(state.directions[0].id, 'direction_work');
    assert.equal(state.active_jobs.length, 0);
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id, private_field: 'must-not-be-serialized' } });
    await send(base, project.id, account.token, { text: '封面换到办公室，自然一点' });
    await send(base, project.id, account.token, { text: '第二张换到公园背景' });
    state = await getState();
    assert.match(state.script!.cover.scene, /办公室/);
    assert.match(state.script!.shots[1].scene, /公园/);
    assert.equal(state.active_jobs.length, 0);
    const history = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    assert.deepEqual(Object.keys(history.find((item) => item.action)?.action || {}).sort(), ['direction_id', 'type']);
    const events = await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    const jobId = events.find((item) => item.type === 'job')!.data.id;
    time += 250;
    state = await getState();
    assert.ok(state.images.every((image) => image.status === 'failed'));
    assert.equal(state.active_jobs.length, 0);
    const failedJob = (await request<Job & { error: string }>(base, `/api/jobs/${jobId}`, { token: account.token })).body;
    assert.equal(failedJob.status, 'failed');
    assert.ok(failedJob.error);
    assert.ok(!failedJob.result_asset_id);
    await copyFile(path.resolve(import.meta.dirname, '../../docs/spike/t-wan-v.jpg'), path.join(fixturesDir, 't-wan-v.jpg'));
    const imageIds = state.images.map((image) => image.id);
    const retry = await send(base, project.id, account.token, { text: '重试没有完成的图片' });
    assert.equal(retry.filter((item) => item.type === 'job').length, 3);
    time += 250;
    const concurrent = await Promise.all([getState(), getState(), getState()]);
    assert.ok(concurrent.every((item) => item.images.every((image) => image.status === 'succeeded')));
    state = concurrent[0];
    assert.deepEqual(state.images.map((image) => image.id), imageIds);
    const database = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { assets: { source: string }[] };
    assert.equal(database.assets.filter((item) => item.source === 'generated').length, 3);
    const order = [...imageIds].reverse();
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: order } });
    await send(base, project.id, account.token, { action: { type: 'confirm_video', image_id: order[0] } });
    time += 250;
    state = await getState();
    assert.equal(state.stage, 'note');
    assert.equal(state.video?.status, 'failed');
    assert.equal(state.pending_action?.type, 'confirm_video');
    await copyFile(path.resolve(import.meta.dirname, '../../docs/spike/v-wan.mp4'), path.join(fixturesDir, 'v-wan.mp4'));
    await send(base, project.id, account.token, { action: { type: 'confirm_video', image_id: order[0] } });
    time += 250;
    state = await getState();
    assert.equal(state.stage, 'done');
    const expiredUrl = state.video!.url!;
    time += 86_402_000;
    assert.equal((await fetch(expiredUrl)).status, 403);
    const refreshed = await getState();
    assert.equal((await fetch(refreshed.video!.url!)).status, 200);
    assert.equal((await fetch(refreshed.garments[0].url)).status, 200);
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: imageIds } });
    state = await getState();
    assert.equal(state.stage, 'note');
    assert.equal(state.video, undefined);
    const refreshedHistory = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    const savedVideo = refreshedHistory.flatMap((item) => item.cards).findLast((item) => item.type === 'video' && item.status === 'succeeded');
    assert.ok(savedVideo?.url);
    assert.equal((await fetch(savedVideo.url)).status, 200);
    await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: imageIds[0], instruction: '背景更明亮' } });
    state = await getState();
    assert.equal(state.stage, 'images');
    assert.equal(state.note, undefined);
    assert.equal(state.video, undefined);
    const rolledBackHistory = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    assert.ok(rolledBackHistory.flatMap((item) => item.cards).filter((item) => item.type === 'note').every((item) => 'image_ids' in item));
    assert.ok(!JSON.stringify(state).includes('ownerId'));
    assert.ok(!JSON.stringify(state).includes('assetId'));
    assert.ok(!JSON.stringify(state).includes('dueAt'));
    time += 6 * 86_400_000;
    assert.equal((await request(base, '/api/me', { token: account.token })).response.status, 401);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('long passwords remain distinct beyond bcrypt 72-byte input limit', async () => {
  const dataDir = await temporaryData('outfit-mock-password-');
  const { server, base } = await startServer(dataDir);
  try {
    const password = `${'长'.repeat(30)}a`;
    assert.equal((await request(base, '/api/auth/register', { body: { username: 'long-password', password } })).response.status, 200);
    assert.equal((await request(base, '/api/auth/login', { body: { username: 'long-password', password } })).response.status, 200);
    assert.equal((await request(base, '/api/auth/login', { body: { username: 'long-password', password: `${'长'.repeat(30)}b` } })).response.status, 401);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});
