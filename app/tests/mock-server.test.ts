import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { MockServerOptions } from '../mock-server/index.mjs';
import type { MessageTrace, ProjectBudget } from '../src/api/types';

interface User { id: string; username: string; nickname: string; created_at: string; tier?: string; daily_budget_cny?: number; today_cost_cny?: number; profile?: { model_asset_ids: string[]; height_cm?: number; body_notes?: string; style_notes?: string } }
interface Account { token: string; user: User }
interface Asset { id: string; url: string; width: number; height: number; source: string; mime: string }
interface Project { id: string; stage: string; brief: string; reference_asset_ids?: string[]; cover_url?: string }
interface Image { id: string; shot_id: string; status: string; version: number; parent_id?: string; anchor_id?: string; url?: string; instruction?: string; script_version?: number; fidelity?: { score: number; diffs: string[]; auto_fixed: boolean; person_score?: number; anchor_score?: number }; region?: { x: number; y: number; w: number; h: number }; edit_check?: { passed: boolean; reason: string } }
interface Job { id: string; kind: string; status: string; result_asset_id?: string; url?: string }
interface State {
  stage: string;
  images: Image[];
  directions: { id: string; name: string; scene: string; mood: string; why: string; preview_status?: string; preview_url?: string; previews?: { id: string; status: string; variant: string; url?: string }[] }[];
  garments: { asset_id: string; url: string }[];
  script?: { status: string; cover: { scene: string }; shots: { scene: string; pose: string; camera: string; caption: string }[] };
  note?: { image_ids: string[]; accepted_unverified_ids?: string[]; title: string; body: string; tags: string[]; cost_cny?: number; cost_points?: number; ai_label: string };
  video?: { status: string; url?: string };
  active_jobs: Job[];
  pending_action: { type: string; estimated_cost_cny?: number } | null;
  budget?: ProjectBudget;
  cost_cny: number;
  last_message_id: string | null;
  script_versions: { version: number; checkpoint_id: string; created_at: string; summary: string; current: boolean }[];
}
interface Card { id: string; type: string; items?: Image[]; options?: { id: string }[]; status?: string; url?: string; poster_url?: string }
interface Message { id: string; role: string; text: string; cards: Card[]; action?: Record<string, unknown>; refs?: string[]; can_regenerate?: boolean; trace?: MessageTrace }
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
  const server = await createMockServer({ dataDir, previewDelayMs: 40, previewStaggerMs: 0, imageDelayMs: 200, imageStaggerMs: 0, editDelayMs: 180, videoDelayMs: 200, runningDelayMs: 30, tokenDelayMs: 0, ...extra });
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

test('profile updates keep photo order, validate ownership atomically, and apply defaults and preferences to new projects', async () => {
  const dataDir = await temporaryData('outfit-mock-profile-');
  const { server, base } = await startServer(dataDir);
  try {
    const owner = await register(base, 'profile-owner');
    const other = await register(base, 'profile-other');
    assert.equal(owner.user.tier, 'free');
    assert.equal(owner.user.daily_budget_cny, 20);
    assert.equal(owner.user.today_cost_cny, 0);
    assert.deepEqual(owner.user.profile, { model_asset_ids: [] });
    const garment = await upload(base, owner.token);
    const first = await upload(base, owner.token, 'model');
    const second = await upload(base, owner.token, 'model');
    const foreign = await upload(base, other.token, 'model');
    const patch = (body: Record<string, unknown>) => request<User>(base, '/api/me', { token: owner.token, method: 'PATCH', body });
    for (const ids of [[foreign.id], [garment.id], [first.id, first.id], ['missing']]) {
      assert.equal((await patch({ nickname: '不应写入', profile: { model_asset_ids: ids } })).response.status, 400);
    }
    assert.equal((await request<User>(base, '/api/me', { token: owner.token })).body.nickname, owner.user.nickname);
    assert.equal((await patch({ profile: { height_cm: '170' } })).response.status, 400);
    assert.equal((await patch({ nickname: '   ' })).response.status, 400);
    const saved = await patch({ nickname: '新昵称', profile: { model_asset_ids: [second.id, first.id], height_cm: 168, body_notes: '肩宽', style_notes: '喜欢通勤，不穿高跟鞋' } });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.nickname, '新昵称');
    assert.deepEqual(saved.body.profile?.model_asset_ids, [second.id, first.id]);
    const partial = await patch({ profile: { height_cm: null, body_notes: '自然体型' } });
    assert.deepEqual(partial.body.profile, { model_asset_ids: [second.id, first.id], body_notes: '自然体型', style_notes: '喜欢通勤，不穿高跟鞋' });
    const input = { title: '默认形象', brand: '个人品牌', brief: '自然日常', garment_asset_ids: [garment.id] };
    const project = (await request<Project>(base, '/api/projects', { token: owner.token, body: input })).body;
    const override = (await request<Project>(base, '/api/projects', { token: owner.token, body: { ...input, model_asset_id: first.id } })).body;
    const stored = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { projects: { id: string; modelAssetId: string }[] };
    assert.equal(stored.projects.find((item) => item.id === project.id)?.modelAssetId, second.id);
    assert.equal(stored.projects.find((item) => item.id === override.id)?.modelAssetId, first.id);
    const events = await send(base, project.id, owner.token, { text: '请给我几个方向' });
    const directionCard = events.find((event) => event.type === 'card' && event.data.type === 'directions')!.data as { options: { id: string; why: string }[] };
    assert.equal(directionCard.options[0].id, 'direction_work');
    assert.ok(directionCard.options.every((option) => option.why.includes('不穿高跟鞋')));
    await send(base, project.id, owner.token, { action: { type: 'choose_direction', direction_id: directionCard.options[0].id } });
    const state = (await request<State>(base, `/api/projects/${project.id}/state`, { token: owner.token })).body;
    assert.ok(state.script?.shots.every((shot) => shot.pose.includes('不穿高跟鞋')));
    await patch({ profile: { model_asset_ids: [] } });
    assert.deepEqual((await request<User>(base, '/api/me', { token: owner.token })).body.profile?.model_asset_ids, []);
    assert.equal((await fetch(first.url)).status, 200);
    const options = await fetch(`${base}/api/me`, { method: 'OPTIONS' });
    assert.match(options.headers.get('access-control-allow-methods') || '', /PATCH/);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('reply regeneration rewrites only the latest safe assistant text, never queues jobs or changes cost/state', async () => {
  const dataDir = await temporaryData('outfit-mock-regenerate-');
  const { server, base } = await startServer(dataDir, { clock: () => Date.parse('2026-10-21T01:00:00Z') });
  try {
    const account = await register(base, 'regenerate-owner');
    const garment = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '改写回复', brand: '个人品牌', brief: '舒服自然', garment_asset_ids: [garment.id] } })).body;
    const messages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    const state = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    await send(base, project.id, account.token, { text: '给我几个方向' });
    const paid = (await messages()).at(-1)!;
    assert.equal(paid.can_regenerate, false);
    const denied = await send(base, project.id, account.token, { action: { type: 'regenerate_reply', message_id: paid.id } });
    assert.equal(denied[0].data.code, 'REGENERATE_NOT_ALLOWED');
    const initial = await state();
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: initial.directions[0].id } });
    const beforeMessages = await messages();
    const safe = beforeMessages.at(-1)!;
    assert.equal(safe.can_regenerate, true);
    const before = await state();
    const replaced = await send(base, project.id, account.token, { action: { type: 'regenerate_reply', message_id: safe.id } });
    assert.deepEqual(replaced.filter((event) => event.type === 'job' || event.type === 'card'), []);
    assert.equal(replaced.at(-1)?.data.message_id, safe.id);
    const afterMessages = await messages();
    assert.equal(afterMessages.length, beforeMessages.length);
    assert.equal(afterMessages.at(-1)?.id, safe.id);
    assert.notEqual(afterMessages.at(-1)?.text, safe.text);
    assert.equal(afterMessages.at(-1)?.can_regenerate, true);
    assert.deepEqual(await state(), before);
    assert.equal((await request<User>(base, '/api/me', { token: account.token })).body.today_cost_cny, 0);
    await send(base, project.id, account.token, { text: '封面姿势自然一点' });
    const previousDenied = await send(base, project.id, account.token, { action: { type: 'regenerate_reply', message_id: safe.id } });
    assert.equal(previousDenied[0].data.code, 'REGENERATE_NOT_ALLOWED');
    assert.equal((await messages()).find((message) => message.id === safe.id)?.can_regenerate, false);
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    const queued = await state();
    const newest = (await messages()).at(-1)!;
    assert.equal(newest.can_regenerate, false);
    const unsafe = await send(base, project.id, account.token, { action: { type: 'regenerate_reply', message_id: newest.id } });
    assert.equal(unsafe[0].data.code, 'REGENERATE_NOT_ALLOWED');
    assert.deepEqual(await state(), queued);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('project deletion cascades generated assets and files, messages and jobs while preserving reusable uploads and daily usage', async () => {
  const dataDir = await temporaryData('outfit-mock-delete-');
  let clock = Date.parse('2026-10-21T01:00:00Z');
  const { server, base } = await startServer(dataDir, { clock: () => clock });
  try {
    const account = await register(base, 'delete-owner');
    const garment = await upload(base, account.token);
    const model = await upload(base, account.token, 'model');
    const input = { title: '将删除', brand: '个人品牌', brief: '舒服自然', garment_asset_ids: [garment.id], model_asset_id: model.id };
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: input })).body;
    const other = (await request<Project>(base, '/api/projects', { token: account.token, body: { ...input, title: '保留的项目' } })).body;
    const state = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    await send(base, project.id, account.token, { text: '给我几个方向' });
    clock += 100;
    const directions = await state();
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: directions.directions[0].id } });
    const jobs = (await send(base, project.id, account.token, { action: { type: 'confirm_script' } })).filter((event) => event.type === 'job');
    clock += 250;
    await state();
    clock += 200;
    const images = (await state()).images.filter((image) => image.status === 'succeeded');
    await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: images[0].id, instruction: '把衣服塞进裤腰' } });
    clock += 200;
    const edited = await state();
    assert.equal(edited.active_jobs.length, 0);
    const last = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body.at(-1)!;
    assert.equal(last.can_regenerate, false);
    const stored = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { assets: { id: string; projectId?: string; filename?: string; source: string }[] };
    const generated = stored.assets.filter((asset) => asset.projectId === project.id);
    const localFile = generated.find((asset) => asset.filename)!;
    assert.ok(localFile);
    assert.ok((await stat(path.join(dataDir, 'uploads', localFile.filename!))).isFile());
    const generatedUrl = edited.images.at(-1)!.url!;
    assert.equal((await fetch(generatedUrl)).status, 200);
    const cost = (await request<User>(base, '/api/me', { token: account.token })).body.today_cost_cny!;
    assert.ok(cost > 0);
    assert.equal((await request(base, `/api/projects/${project.id}`, { token: account.token, method: 'DELETE' })).response.status, 204);
    for (const route of ['', '/state', '/messages']) assert.equal((await request(base, `/api/projects/${project.id}${route}`, { token: account.token })).response.status, 404);
    assert.equal((await request(base, `/api/jobs/${jobs[0].data.id}`, { token: account.token })).response.status, 404);
    assert.equal((await fetch(generatedUrl)).status, 404);
    await assert.rejects(stat(path.join(dataDir, 'uploads', localFile.filename!)), { code: 'ENOENT' });
    assert.equal((await fetch(garment.url)).status, 200);
    assert.equal((await fetch(model.url)).status, 200);
    const remaining = (await request<Project[]>(base, '/api/projects', { token: account.token })).body;
    assert.deepEqual(remaining.map((item) => item.id), [other.id]);
    assert.equal((await request<User>(base, '/api/me', { token: account.token })).body.today_cost_cny, cost);
    const after = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { assets: { id: string }[]; jobs: { project_id: string }[] };
    assert.ok(generated.every((asset) => !after.assets.some((item) => item.id === asset.id)));
    assert.ok(!after.jobs.some((job) => job.project_id === project.id));
    clock += 86_400_000;
    assert.equal((await request<User>(base, '/api/me', { token: account.token })).body.today_cost_cny, 0);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

for (const mode of ['missing', 'old-fields'] as const) test(`legacy ${mode} profile mode preserves existing project and conversation endpoints`, async () => {
  const dataDir = await temporaryData('outfit-mock-legacy-');
  const { server, base } = await startServer(dataDir, { legacyProfile: mode });
  try {
    const account = await register(base, `legacy-${mode}`);
    assert.equal(account.user.profile, undefined);
    const me = await request<User>(base, '/api/me', { token: account.token });
    assert.equal(me.response.status, mode === 'missing' ? 404 : 200);
    if (mode === 'old-fields') assert.deepEqual(Object.keys(me.body).sort(), ['created_at', 'id', 'nickname', 'username']);
    assert.equal((await request(base, '/api/me', { token: account.token, method: 'PATCH', body: { nickname: '新昵称' } })).response.status, 404);
    const garment = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '旧服务', brand: '个人品牌', brief: '自然穿搭', garment_asset_ids: [garment.id] } })).body;
    const events = await send(base, project.id, account.token, { text: '帮我做穿搭笔记' });
    assert.ok(events.some((event) => event.type === 'done'));
    assert.ok(!events.some((event) => event.type === 'trace'));
    const state = (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    assert.equal(state.budget, undefined);
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    const script = (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    assert.equal(script.pending_action?.estimated_cost_cny, undefined);
    assert.ok((await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body.every((message) => !message.trace));
    assert.equal((await request(base, `/api/projects/${project.id}`, { token: account.token, method: 'DELETE' })).response.status, 204);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

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
    assert.equal(current.images[0].status, 'running');
    assert.ok(current.images.slice(1).every((image) => image.status === 'queued'));
    await closeServer(server);
    ({ server, base } = await startServer(dataDir));
    assert.equal((await state()).active_jobs.length, 3);
    await wait(190);
    current = await state();
    assert.equal(current.images[0].status, 'succeeded');
    assert.ok(current.images.slice(1).every((image) => image.status === 'queued' && image.anchor_id === current.images[0].id));
    assert.equal(current.active_jobs.length, 2);
    await wait(220);
    current = await state();
    assert.equal(current.images.find((image) => image.fidelity?.score === 54)?.shot_id, 'shot_3');
    assert.equal(current.active_jobs.length, 1);
    await wait(200);
    current = await state();
    assert.ok(current.images.every((image) => image.status === 'succeeded'));
    assert.deepEqual(current.active_jobs, []);
    const original = current.images[0];
    assert.equal((await fetch(original.url!)).status, 200);
    const edit = await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: original.id, instruction: '把衬衫塞进裤腰，背景更明亮' } });
    assert.equal(edit.find((event) => event.type === 'job')?.data.kind, 'edit');
    current = await state();
    assert.equal(current.images.length, 5);
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
    assert.ok(imageCards.every((item) => item.items?.length === 5 && item.items.every((image) => image.status === 'succeeded')));
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

test('mock revisions preserve drafts, missing media fails/retries, refreshed links survive expiry and edits preserve published content', async () => {
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
    assert.equal(state.active_jobs.length, 9);
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id, private_field: 'must-not-be-serialized' } });
    await send(base, project.id, account.token, { text: '封面换到办公室，自然一点' });
    await send(base, project.id, account.token, { text: '第二张换到公园背景' });
    state = await getState();
    assert.match(state.script!.cover.scene, /办公室/);
    assert.match(state.script!.shots[1].scene, /公园/);
    assert.equal(state.active_jobs.length, 9);
    const history = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    assert.deepEqual(Object.keys(history.find((item) => item.action)?.action || {}).sort(), ['direction_id', 'type']);
    const events = await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    const jobId = events.find((item) => item.type === 'job')!.data.id;
    time += 250;
    state = await getState();
    assert.ok(state.images.every((image) => image.status === 'failed'));
    assert.ok(state.directions.every((direction) => direction.preview_status === 'failed' && !direction.preview_url));
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
    assert.ok(concurrent.every((item) => item.images.length === 4 && item.images.filter((image) => image.status === 'succeeded').length === 3));
    time += 250;
    assert.ok((await getState()).images.every((image) => image.status === 'succeeded'));
    state = concurrent[0];
    assert.deepEqual(state.images.slice(0, 3).map((image) => image.id), imageIds);
    const database = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { assets: { source: string; ownerId: string | null }[] };
    assert.equal(database.assets.filter((item) => item.source === 'generated' && item.ownerId !== null).length, 4);
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
    const doneNote = structuredClone(refreshed.note!);
    const doneVideoPath = new URL(refreshed.video!.url!).pathname;
    const donePending = refreshed.pending_action;
    await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: imageIds[0], instruction: '换个姿势' } });
    state = await getState();
    assert.equal(state.stage, 'done');
    assert.deepEqual(state.note, doneNote);
    assert.deepEqual(state.pending_action, donePending);
    assert.equal(new URL(state.video!.url!).pathname, doneVideoPath);
    assert.equal(state.images.at(-1)!.status, 'queued');
    time += 250;
    state = await getState();
    assert.equal(state.stage, 'done');
    assert.deepEqual(state.note, { ...doneNote, cost_cny: Math.round((doneNote.cost_cny! + 0.5) * 100) / 100, cost_points: Math.round((doneNote.cost_cny! + 0.5) * 100) / 10 });
    assert.deepEqual(state.pending_action, donePending);
    assert.equal(state.video!.status, 'succeeded');
    assert.equal(new URL(state.video!.url!).pathname, doneVideoPath);
    assert.equal((await fetch(state.video!.url!)).status, 200);
    assert.equal(state.images.at(-1)!.status, 'succeeded');
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: imageIds } });
    state = await getState();
    assert.equal(state.stage, 'done');
    assert.equal(state.video?.status, 'succeeded');
    assert.equal(new URL(state.video!.url!).pathname, doneVideoPath);
    const refreshedHistory = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    const savedVideo = refreshedHistory.flatMap((item) => item.cards).findLast((item) => item.type === 'video' && item.status === 'succeeded');
    assert.ok(savedVideo?.url);
    assert.equal((await fetch(savedVideo.url)).status, 200);
    const noteBeforeEdit = structuredClone(state.note!);
    const pendingBeforeEdit = state.pending_action;
    await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: imageIds[0], instruction: '背景更明亮' } });
    state = await getState();
    assert.equal(state.stage, 'done');
    assert.deepEqual(state.note, noteBeforeEdit);
    assert.deepEqual(state.pending_action, pendingBeforeEdit);
    assert.equal(state.video?.status, 'succeeded');
    assert.equal(new URL(state.video!.url!).pathname, doneVideoPath);
    assert.equal(state.images.at(-1)!.status, 'queued');
    time += 250;
    state = await getState();
    assert.equal(state.stage, 'done');
    assert.deepEqual(state.note, { ...noteBeforeEdit, cost_cny: Math.round((noteBeforeEdit.cost_cny! + 0.5) * 100) / 100, cost_points: Math.round((noteBeforeEdit.cost_cny! + 0.5) * 100) / 10 });
    assert.deepEqual(state.pending_action, pendingBeforeEdit);
    assert.equal(state.video?.status, 'succeeded');
    assert.equal(new URL(state.video!.url!).pathname, doneVideoPath);
    assert.equal(state.images.at(-1)!.status, 'succeeded');
    const preservedHistory = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    assert.ok(preservedHistory.flatMap((item) => item.cards).filter((item) => item.type === 'note').every((item) => 'image_ids' in item));
    assert.ok(!JSON.stringify(state).includes('ownerId'));
    assert.ok(!JSON.stringify(state).includes('assetId'));
    assert.ok(!JSON.stringify(state).includes('dueAt'));
    time += 6 * 86_400_000;
    assert.equal((await request(base, '/api/me', { token: account.token })).response.status, 401);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('second-round fixtures preview directions, announce once, auto-fix one version, and restore script without losing images', async () => {
  const dataDir = await temporaryData('outfit-mock-contract-');
  let time = Date.now();
  const options = { clock: () => time, previewDelayMs: 200 };
  let { server, base } = await startServer(dataDir, options);
  try {
    const account = await register(base, 'new-contract');
    const asset = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '新字段演示', brand: '木棉', brief: '自然松弛的穿搭笔记', garment_asset_ids: [asset.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    const getMessages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    let state = await getState();
    assert.equal(state.cost_cny, 0);
    assert.equal(state.last_message_id, null);
    assert.deepEqual(state.script_versions, []);

    const directions = await send(base, project.id, account.token, { text: '帮我想三个穿搭方向' });
    const responseId = directions.at(-1)!.data.message_id;
    state = await getState();
    assert.equal(state.last_message_id, responseId);
    assert.equal(state.active_jobs.length, 9);
    assert.ok(state.active_jobs.every((job) => job.kind === 'image'));
    assert.ok(state.directions.every((direction) => direction.preview_status === 'queued' && !direction.preview_url));
    time += 35;
    state = await getState();
    assert.ok(state.directions.every((direction) => direction.preview_status === 'running'));
    assert.equal(state.last_message_id, responseId);
    time += 200;
    state = await getState();
    assert.ok(state.directions.every((direction) => direction.preview_status === 'succeeded' && direction.preview_url));
    assert.equal(state.cost_cny, 4.5);
    assert.equal(state.active_jobs.length, 0);
    assert.notEqual(state.last_message_id, responseId);
    assert.equal((await fetch(state.directions[0].preview_url!)).status, 200);
    let messages = await getMessages();
    assert.equal(messages.at(-1)!.id, state.last_message_id);
    assert.match(messages.at(-1)!.text, /三张灵感图都准备好了/);
    const previewMessageCount = messages.length;
    await Promise.all([getState(), getMessages(), getState()]);
    assert.equal((await getMessages()).length, previewMessageCount);

    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    state = await getState();
    const originalScript = structuredClone(state.script);
    const originalCheckpoint = state.script_versions[0].checkpoint_id;
    assert.equal(state.script_versions[0].current, true);
    await send(base, project.id, account.token, { text: '把脚本换成通勤风。' });
    state = await getState();
    assert.deepEqual(state.script_versions.map((version) => [version.version, version.current]), [[1, false], [2, true]]);
    assert.match(state.script_versions[1].summary, /通勤风/);
    assert.ok(state.script_versions.every((version) => !Number.isNaN(Date.parse(version.created_at))));
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    time += 250;
    state = await getState();
    const flawed = state.images.find((image) => image.fidelity?.score === 54)!;
    assert.equal(flawed.shot_id, 'shot_3');
    assert.deepEqual(flawed.fidelity?.diffs, ['左侧胸袋缺失', '纽扣位置与原衣服不一致']);
    assert.equal(flawed.fidelity?.auto_fixed, false);
    const repair = state.images.find((image) => image.parent_id === flawed.id)!;
    assert.equal(repair.status, 'queued');
    assert.equal(repair.version, flawed.version + 1);
    assert.equal(repair.script_version, 2);
    assert.match(repair.instruction!, /自动修复.*胸袋.*纽扣/);
    assert.equal(state.active_jobs.length, 1);
    assert.equal(state.active_jobs[0].kind, 'edit');
    time += 200;
    state = await getState();
    assert.deepEqual(state.images.find((image) => image.id === repair.id)?.fidelity, { score: 92, diffs: [], auto_fixed: true });
    assert.equal(state.images.length, 4);
    assert.ok(state.images.every((image) => image.status === 'succeeded' && image.script_version === 2));
    assert.equal(state.cost_cny, 6.5);
    messages = await getMessages();
    assert.equal(messages.at(-1)!.id, state.last_message_id);
    assert.match(messages.at(-1)!.text, /3 张都好了.*自动补了一版/);
    const completedCount = messages.length;
    time += 500;
    await Promise.all([getState(), getState(), getMessages()]);
    assert.equal((await getMessages()).length, completedCount);
    assert.equal((await getState()).images.length, 4);
    const approvedIds = [repair.id, state.images[0].id, state.images[1].id];
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: approvedIds } });
    state = await getState();
    assert.equal(state.note!.cost_cny, state.cost_cny);
    assert.match(state.note!.ai_label, /AI.*发布.*声明/);
    assert.deepEqual(state.note!.image_ids, approvedIds);
    const imageIds = state.images.map((image) => image.id);
    const invalid = await send(base, project.id, account.token, { action: { type: 'restore_script', checkpoint_id: 'unknown' } });
    assert.equal(invalid[0].data.code, 'INVALID_CHECKPOINT');
    assert.equal((await getState()).stage, 'note');
    await send(base, project.id, account.token, { action: { type: 'restore_script', checkpoint_id: originalCheckpoint, private_field: 'not-public' } });
    state = await getState();
    assert.equal(state.stage, 'script');
    assert.equal(state.pending_action!.type, 'confirm_script');
    assert.deepEqual(state.script, originalScript);
    assert.deepEqual(state.images.map((image) => image.id), imageIds);
    assert.deepEqual(state.script_versions.map((version) => [version.version, version.current]), [[1, true], [2, false]]);
    const restoreMessage = (await getMessages()).findLast((message) => message.action?.type === 'restore_script')!;
    assert.deepEqual(restoreMessage.action, { type: 'restore_script', checkpoint_id: originalCheckpoint });
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    state = await getState();
    assert.deepEqual(state.images.slice(0, 4).map((image) => image.id), imageIds);
    assert.equal(state.images.length, 7);
    assert.ok(state.images.slice(4).every((image) => image.script_version === 1 && image.status === 'queued'));
    time += 250;
    await getState();
    time += 200;
    state = await getState();
    assert.equal(state.images.length, 8);
    assert.equal(state.cost_cny, 8.5);
    assert.equal(state.images.filter((image) => image.fidelity?.auto_fixed).length, 2);
    assert.ok(!JSON.stringify(state).includes('automatic'));
    assert.ok(!JSON.stringify(state).includes('autoFixAttempted'));
    assert.ok(!JSON.stringify(state).includes('previewAssetId'));
    const latestId = state.last_message_id;
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    const restarted = await getState();
    assert.equal(restarted.last_message_id, latestId);
    assert.equal(restarted.cost_cny, state.cost_cny);
    assert.deepEqual(restarted.script_versions, state.script_versions);
    assert.deepEqual(restarted.images.map((image) => image.id), state.images.map((image) => image.id));
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('local rectangle/brush edits preserve outside pixels, reject bad selections, persist refs, and retry a failed edit check', async () => {
  const dataDir = await temporaryData('outfit-mock-local-');
  let time = Date.now();
  const options = { clock: () => time };
  let { server, base } = await startServer(dataDir, options);
  try {
    const account = await register(base, 'local-editor');
    const garment = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '局部改演示', brand: '木棉', brief: '自然的穿搭', garment_asset_ids: [garment.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    const getMessages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    await send(base, project.id, account.token, { text: '先给我几个方向' });
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: (await getState()).directions[0].id } });
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    time += 250;
    await getState();
    time += 200;
    let state = await getState();
    const original = state.images[0];
    const originalBytes = Buffer.from(await (await fetch(original.url!)).arrayBuffer());
    const decoded = await sharp(originalBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    const originalCount = state.images.length;
    const messageCount = (await getMessages()).length;
    const localAction = { type: 'edit_image', image_id: original.id, instruction: '袖口放下来' };
    const region = { x: 0.2, y: 0.3, w: 0.25, h: 0.2 };
    const badSelections = [
      { region: null }, { region: [] }, { region: { ...region, x: -0.1 } }, { region: { ...region, w: 0 } },
      { region: { ...region, h: '0.2' } }, { region: { ...region, x: 0.9 } }, { region: { ...region, y: 0.9 } },
      { region: { ...region, w: null } }, { region, mask_strokes: { brush: 0.1, strokes: [[{ x: 0.5, y: 0.5 }]] } },
      { mask_strokes: null }, { mask_strokes: { brush: 0, strokes: [[{ x: 0.5, y: 0.5 }]] } },
      { mask_strokes: { brush: 1.1, strokes: [[{ x: 0.5, y: 0.5 }]] } }, { mask_strokes: { brush: 0.1, strokes: [] } },
      { mask_strokes: { brush: 0.1, strokes: [[]] } }, { mask_strokes: { brush: 0.1, strokes: [[{ x: 1.1, y: 0.5 }]] } },
      { mask_strokes: { brush: 0.1, strokes: [[null]] } }, { mask_strokes: { brush: 0.1, strokes: [[{ x: 0.5 }]] } },
    ];
    for (const selection of badSelections) {
      const events = await send(base, project.id, account.token, { action: { ...localAction, ...selection } });
      assert.equal(events[0].type, 'error', JSON.stringify(selection));
      assert.match(String(events[0].data.code), /^INVALID_(REGION|MASK|SELECTION)$/);
    }
    for (const refs of [null, original.id, [original.id, original.id], ['unknown'], [garment.id], [1]]) {
      assert.equal((await send(base, project.id, account.token, { text: '看这张', refs }))[0].data.code, 'INVALID_REFS');
    }
    assert.equal((await getState()).images.length, originalCount);
    assert.equal((await getMessages()).length, messageCount);
    await send(base, project.id, account.token, { action: { ...localAction, region: { ...region, internal: 'hidden' } }, refs: [original.id] });
    state = await getState();
    const firstEditId = state.images.at(-1)!.id;
    assert.deepEqual(state.images.at(-1)!.region, region);
    assert.equal((await send(base, project.id, account.token, { text: '还没完成', refs: [firstEditId] }))[0].data.code, 'INVALID_REFS');
    time += 250;
    state = await getState();
    const firstEdit = state.images.find((image) => image.id === firstEditId)!;
    assert.equal(firstEdit.status, 'succeeded');
    assert.equal(firstEdit.edit_check?.passed, false);
    assert.match(firstEdit.edit_check!.reason, /没改到位|未改到位/);
    assert.match((await getMessages()).at(-1)!.text, /可能没改到位/);
    const rectResponse = await fetch(firstEdit.url!);
    assert.equal(rectResponse.headers.get('content-type'), 'image/png');
    const rectanglePixels = await sharp(Buffer.from(await rectResponse.arrayBuffer())).ensureAlpha().raw().toBuffer();
    let changedInside = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * channels;
        const changed = !decoded.data.subarray(offset, offset + channels).equals(rectanglePixels.subarray(offset, offset + channels));
        const inside = (x + 0.5) / width >= region.x && (x + 0.5) / width < region.x + region.w && (y + 0.5) / height >= region.y && (y + 0.5) / height < region.y + region.h;
        if (inside && changed) changedInside += 1;
        else assert.equal(changed, false, `rectangle changed outside at ${x},${y}`);
      }
    }
    assert.ok(changedInside > 1000, 'rectangle edit should be clearly visible');
    const firstMessage = (await getMessages()).findLast((message) => message.action?.type === 'edit_image')!;
    assert.deepEqual(firstMessage.refs, [original.id]);
    assert.deepEqual(firstMessage.action, { ...localAction, region });

    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    assert.deepEqual((await getMessages()).find((message) => message.id === firstMessage.id)?.refs, [original.id]);
    await send(base, project.id, account.token, { action: { ...localAction, image_id: firstEditId, region } });
    time += 250;
    state = await getState();
    const retry = state.images.at(-1)!;
    assert.equal(retry.parent_id, firstEditId);
    assert.equal(retry.version, firstEdit.version + 1);
    assert.equal(retry.edit_check?.passed, true);
    assert.deepEqual(retry.region, region);

    const mask = { brush: 0.12, strokes: [[{ x: 0.35, y: 0.4 }, { x: 0.6, y: 0.55 }], [{ x: 0.7, y: 0.75 }]] };
    await send(base, project.id, account.token, { action: { ...localAction, mask_strokes: mask } });
    const brushEditId = (await getState()).images.at(-1)!.id;
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    time += 250;
    state = await getState();
    const brushEdit = state.images.find((image) => image.id === brushEditId)!;
    assert.equal(brushEdit.edit_check?.passed, true);
    assert.ok(brushEdit.region);
    assert.ok(Math.abs(brushEdit.region.x - 0.29) < 0.000001);
    assert.ok(Math.abs(brushEdit.region.y - 0.355) < 0.000001);
    assert.ok(Math.abs(brushEdit.region.w - 0.47) < 0.000001);
    assert.ok(Math.abs(brushEdit.region.h - 0.44) < 0.000001);
    const brushPixels = await sharp(Buffer.from(await (await fetch(brushEdit.url!)).arrayBuffer())).ensureAlpha().raw().toBuffer();
    const radius = mask.brush * Math.min(width, height) / 2;
    const a = { x: mask.strokes[0][0].x * width, y: mask.strokes[0][0].y * height };
    const b = { x: mask.strokes[0][1].x * width, y: mask.strokes[0][1].y * height };
    let brushChanged = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * channels;
        const changed = !decoded.data.subarray(offset, offset + channels).equals(brushPixels.subarray(offset, offset + channels));
        if (!changed) continue;
        brushChanged += 1;
        const t = Math.max(0, Math.min(1, (((x + 0.5) - a.x) * (b.x - a.x) + ((y + 0.5) - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
        const segmentDistance = Math.hypot(x + 0.5 - a.x - t * (b.x - a.x), y + 0.5 - a.y - t * (b.y - a.y));
        const pointDistance = Math.hypot(x + 0.5 - 0.7 * width, y + 0.5 - 0.75 * height);
        assert.ok(Math.min(segmentDistance, pointDistance) <= radius + 1.5, `brush changed outside at ${x},${y}`);
      }
    }
    assert.ok(brushChanged > 1000, 'brush edit should be clearly visible');
    await send(base, project.id, account.token, { text: '这两版放一起看看', refs: [original.id, brushEdit.id] });
    const refsMessage = (await getMessages()).findLast((message) => message.role === 'user')!;
    assert.deepEqual(refsMessage.refs, [original.id, brushEdit.id]);
    const otherProject = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '另一个项目', brand: '木棉', brief: '测试引用归属', garment_asset_ids: [garment.id] } })).body;
    assert.equal((await send(base, otherProject.id, account.token, { text: '不能引用其他项目', refs: [original.id] }))[0].data.code, 'INVALID_REFS');
    assert.ok(!JSON.stringify(state).includes('editSelection'));
    assert.ok(!JSON.stringify(state).includes('editCheckShouldFail'));
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    assert.deepEqual((await getMessages()).find((message) => message.id === refsMessage.id)?.refs, refsMessage.refs);
    assert.equal((await getState()).images.find((image) => image.id === firstEditId)?.edit_check?.passed, false);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('eighth-round approval requires explicit failed-check consent and rewrites a note with ordered versions', async () => {
  const dataDir = await temporaryData('outfit-mock-trusted-note-');
  let time = Date.parse('2026-10-21T01:00:00Z');
  const options = { clock: () => time };
  let { server, base } = await startServer(dataDir, options);
  try {
    const account = await register(base, 'trusted-note');
    const garment = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '可信用图', brand: '木棉', brief: '自然穿搭', garment_asset_ids: [garment.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    const getMessages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    const directions = await send(base, project.id, account.token, { text: '先给我几个方向' });
    assert.equal(directions.find((event) => event.type === 'card' && event.data.type === 'directions')?.data.regenerate_estimate_cny, 4.5);
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: (await getState()).directions[0].id } });
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    time += 250;
    await getState();
    time += 250;
    let state = await getState();
    const original = state.images[0];
    const second = state.images[1];
    const instruction = '袖口放下来';
    await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: original.id, instruction, region: { x: 0.2, y: 0.3, w: 0.25, h: 0.2 }, attempt: 'failed-check' } });
    time += 250;
    state = await getState();
    const unverified = state.images.at(-1)!;
    assert.equal(unverified.status, 'succeeded', 'a failed quality check is still a successfully paid image');
    assert.equal(unverified.edit_check?.passed, false);
    const historyBefore = await getMessages();
    const denied = await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: [second.id, unverified.id] } });
    assert.equal(denied[0].data.code, 'unverified_image');
    assert.match(String(denied[0].data.message), /镜头 1/);
    assert.ok(String(denied[0].data.message).includes(unverified.edit_check!.reason));
    assert.deepEqual(await getState(), state);
    assert.deepEqual(await getMessages(), historyBefore);
    for (const accept_unverified of [null, unverified.id, [unverified.id, unverified.id], ['missing'], [42]]) {
      assert.equal((await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: [second.id, unverified.id], accept_unverified } }))[0].data.code, 'INVALID_ACCEPT_UNVERIFIED');
    }
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: [second.id, original.id] } });
    state = await getState();
    assert.deepEqual(state.note?.image_ids, [second.id, original.id]);
    assert.deepEqual(state.note?.accepted_unverified_ids, []);
    assert.ok(!state.note?.body.includes(instruction), 'an unapproved edit request must not become a visible picture fact');
    const originalNote = structuredClone(state.note!);
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: [second.id, unverified.id], accept_unverified: [unverified.id] } });
    state = await getState();
    assert.equal(state.stage, 'note');
    assert.deepEqual(state.note?.image_ids, [second.id, unverified.id]);
    assert.deepEqual(state.note?.accepted_unverified_ids, [unverified.id]);
    assert.ok(state.note?.body.includes(instruction));
    assert.notEqual(state.note?.body, originalNote.body);
    const storedAction = (await getMessages()).findLast((message) => message.action?.type === 'approve_images')!.action;
    assert.deepEqual(storedAction, { type: 'approve_images', image_ids: [second.id, unverified.id], accept_unverified: [unverified.id] });
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    assert.deepEqual((await getState()).note, state.note);
    const replayedDirections = (await getMessages()).flatMap((message) => message.cards).find((card) => card.type === 'directions') as Card & { regenerate_estimate_cny?: number };
    assert.equal(replayedDirections.regenerate_estimate_cny, 4.5);
    await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: original.id, instruction: '背景亮一点', attempt: 'verified-version' } });
    time += 250;
    state = await getState();
    const verified = state.images.at(-1)!;
    assert.equal(verified.edit_check?.passed, true);
    assert.deepEqual(state.note?.image_ids, [second.id, unverified.id], 'note-stage edits keep current published selection until explicit adoption');
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: [second.id, verified.id] } });
    state = await getState();
    assert.deepEqual(state.note?.image_ids, [second.id, verified.id]);
    assert.deepEqual(state.note?.accepted_unverified_ids, []);
    assert.ok(state.note?.body.includes('背景亮一点'));
    assert.ok(!state.note?.body.includes(instruction), 'replacing a manually adopted version clears its picture facts');
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('eighth-round edit attempts replay one task across restart and a new attempt generates a new paid version', async () => {
  const dataDir = await temporaryData('outfit-mock-attempts-');
  let time = Date.parse('2026-10-21T01:00:00Z');
  const options = { clock: () => time };
  let { server, base } = await startServer(dataDir, options);
  try {
    const account = await register(base, 'edit-attempts');
    const garment = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '改图新尝试', brand: '木棉', brief: '自然穿搭', garment_asset_ids: [garment.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    await send(base, project.id, account.token, { text: '先给我几个方向' });
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: (await getState()).directions[0].id } });
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    time += 250;
    await getState();
    time += 250;
    let state = await getState();
    const original = state.images[0];
    const action = { type: 'edit_image', image_id: original.id, instruction: '背景亮一点', attempt: 'attempt-one' };
    const originalCount = state.images.length;
    const originalCost = state.cost_cny;
    for (const attempt of [null, 42, '', 'a'.repeat(65)]) {
      assert.equal((await send(base, project.id, account.token, { action: { ...action, attempt } }))[0].data.code, 'INVALID_ATTEMPT');
    }
    const submitted = await send(base, project.id, account.token, { action });
    const firstJob = submitted.find((event) => event.type === 'job')!.data;
    assert.equal(firstJob.reused, false);
    assert.equal(submitted.at(-1)?.data.reused, false);
    const replay = await send(base, project.id, account.token, { action });
    assert.equal(replay.find((event) => event.type === 'job')?.data.id, firstJob.id);
    assert.equal(replay.find((event) => event.type === 'job')?.data.reused, true);
    assert.equal(replay.at(-1)?.data.reused, true);
    assert.ok(replay.filter((event) => event.type === 'token').map((event) => event.data.delta).join('').includes('没有重新生成'));
    state = await getState();
    assert.equal(state.images.length, originalCount + 1);
    assert.equal(state.active_jobs.filter((job) => job.kind === 'edit').length, 1);
    assert.equal(state.cost_cny, originalCost);
    time += 250;
    state = await getState();
    assert.equal(state.cost_cny, Math.round((originalCost + 0.5) * 100) / 100);
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    const completedReplay = await send(base, project.id, account.token, { action });
    assert.equal(completedReplay.find((event) => event.type === 'job')?.data.id, firstJob.id);
    assert.equal(completedReplay.find((event) => event.type === 'job')?.data.status, 'succeeded');
    assert.equal(completedReplay.find((event) => event.type === 'job')?.data.reused, true);
    assert.equal((await getState()).images.length, originalCount + 1);
    const secondAttempt = await send(base, project.id, account.token, { action: { ...action, attempt: 'attempt-two' } });
    assert.notEqual(secondAttempt.find((event) => event.type === 'job')?.data.id, firstJob.id);
    assert.equal(secondAttempt.at(-1)?.data.reused, false);
    time += 250;
    state = await getState();
    assert.equal(state.images.length, originalCount + 2);
    assert.equal(state.cost_cny, Math.round((originalCost + 1) * 100) / 100);
    await send(base, project.id, account.token, { action: { ...action, region: { x: 0.2, y: 0.3, w: 0.25, h: 0.2 } } });
    assert.equal((await getState()).images.length, originalCount + 3, 'selection is part of the deduplication key');
    await send(base, project.id, account.token, { action: { ...action, instruction: '背景换成公园' } });
    assert.equal((await getState()).images.length, originalCount + 4, 'instruction is part of the deduplication key');
    const legacyAction = { type: 'edit_image', image_id: original.id, instruction: '姿势自然一点' };
    await send(base, project.id, account.token, { action: legacyAction });
    await send(base, project.id, account.token, { action: legacyAction });
    assert.equal((await getState()).images.length, originalCount + 6, 'omitting attempt retains the existing local mock behavior');
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

test('sixth-round streams and restores traces, replaces directions with previews while keeping preferences, and matches worker cost to budget', async () => {
  const dataDir = await temporaryData('outfit-mock-transparent-');
  let time = Date.parse('2026-10-21T01:00:00Z');
  const options = { clock: () => time };
  let { server, base } = await startServer(dataDir, options);
  try {
    const account = await register(base, 'transparent-flow');
    const garment = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '透明创作', brand: '木棉', brief: '日常合作', garment_asset_ids: [garment.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    const getMessages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    const sendTraced = async (body: Record<string, unknown>, tool: MessageTrace['tool']) => {
      const events = await send(base, project.id, account.token, body);
      const traceIndex = events.findIndex((event) => event.type === 'trace');
      assert.ok(traceIndex >= 0 && traceIndex < events.findIndex((event) => event.type === 'done'));
      const trace = events[traceIndex].data;
      assert.equal(trace.tool, tool);
      assert.equal(trace.cost_cny, 0, 'local text/tool dispatch does not bill providers');
      assert.deepEqual((await getMessages()).at(-1)?.trace, trace);
      return events;
    };
    assert.deepEqual((await getState()).budget, { tier: 'free', daily_budget_cny: 20, today_cost_cny: 0, remaining_cny: 20, daily_budget_points: 200, today_cost_points: 0, remaining_points: 200 });
    const first = await sendTraced({ text: '想要通勤，傍晚拍摄，自然一点' }, 'propose_directions');
    const firstCard = first.find((event) => event.type === 'card' && event.data.type === 'directions')!.data;
    time += 250;
    let state = await getState();
    assert.equal(state.cost_cny, 4.5);
    const oldDirections = structuredClone(state.directions);
    const second = await sendTraced({ text: '换一组方向，保留我刚才说的偏好' }, 'propose_directions');
    const nextCard = second.find((event) => event.type === 'card' && event.data.type === 'directions')!.data;
    assert.equal(nextCard.id, firstCard.id);
    state = await getState();
    assert.ok(state.directions.every((direction) => !oldDirections.some((old) => old.id === direction.id || old.name === direction.name)));
    assert.ok(state.directions[0].id.startsWith('direction_work_'));
    assert.ok(state.directions.every((direction) => direction.scene.startsWith('傍晚的') && direction.mood.includes('自然') && direction.why.includes('通勤')));
    assert.ok(state.directions.every((direction) => direction.preview_status === 'queued'));
    time += 250;
    state = await getState();
    assert.ok(state.directions.every((direction) => direction.preview_status === 'succeeded' && direction.preview_url));
    assert.equal((await fetch(state.directions[0].preview_url!)).status, 200);
    assert.equal((await getMessages()).at(-1)?.trace?.cost_cny, 4.5);
    assert.match((await getMessages()).at(-1)?.trace?.steps[0].label || '', /方向预览 9 张/);
    await sendTraced({ action: { type: 'choose_direction', direction_id: state.directions[0].id } }, 'write_script');
    state = await getState();
    assert.equal(state.pending_action?.estimated_cost_cny, 1.8);
    assert.equal(state.budget?.remaining_cny, 11);
    const safeReply = (await getMessages()).at(-1)!;
    const regenerated = await sendTraced({ action: { type: 'regenerate_reply', message_id: safeReply.id } }, 'chat');
    assert.equal(regenerated.at(-1)?.data.message_id, safeReply.id);
    assert.ok(!regenerated.some((event) => ['card', 'job'].includes(event.type)));
    await sendTraced({ text: '封面姿势自然一点' }, 'revise_script');
    const checkpoint = (await getState()).script_versions[0].checkpoint_id;
    await sendTraced({ action: { type: 'restore_script', checkpoint_id: checkpoint } }, 'restore_script');
    await sendTraced({ action: { type: 'confirm_script' } }, 'generate_images');
    time += 250;
    await getState();
    time += 250;
    state = await getState();
    const completed = (await getMessages()).at(-1)!;
    assert.equal(completed.trace?.tool, 'generate_images');
    assert.equal(completed.trace?.cost_cny, 2);
    assert.equal(completed.trace?.duration_ms, 500, 'worker trace includes the sequential automatic repair');
    assert.ok(completed.trace?.steps.some((step) => step.label === '出图 3 张'));
    assert.ok(completed.trace?.steps.some((step) => step.label === '自动修复 1 张'));
    assert.deepEqual(state.budget, { tier: 'free', daily_budget_cny: 20, today_cost_cny: 11, remaining_cny: 9, daily_budget_points: 200, today_cost_points: 110, remaining_points: 90 });
    const image = state.images[0];
    await sendTraced({ action: { type: 'edit_image', image_id: image.id, instruction: '背景更明亮' }, refs: [image.id] }, 'edit_image');
    assert.deepEqual((await getMessages()).at(-1)?.trace?.refs, [image.id]);
    time += 250;
    state = await getState();
    assert.equal((await getMessages()).at(-1)?.trace?.cost_cny, 0.5);
    await sendTraced({ action: { type: 'approve_images', image_ids: [image.id] } }, 'write_note');
    state = await getState();
    assert.equal(state.pending_action?.estimated_cost_cny, 1.5);
    await sendTraced({ action: { type: 'confirm_video', image_id: image.id } }, 'generate_video');
    time += 250;
    state = await getState();
    const messages = await getMessages();
    assert.ok(messages.filter((message) => message.role === 'assistant').every((message) => message.trace && message.trace.steps.length > 0 && message.trace.duration_ms >= 0));
    assert.equal(messages.at(-1)?.trace?.cost_cny, 1.5);
    assert.equal(state.cost_cny, state.budget?.today_cost_cny);
    assert.equal((await request<User>(base, '/api/me', { token: account.token })).body.today_cost_cny, state.budget?.today_cost_cny);
    const savedTrace = messages.at(-1)?.trace;
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    assert.deepEqual((await getMessages()).at(-1)?.trace, savedTrace);
    assert.deepEqual((await getState()).budget, state.budget);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('sixth-round budget rejects paid actions atomically, reserves queued jobs, caps automatic repair, and resets daily balance', async () => {
  const dataDir = await temporaryData('outfit-mock-budget-');
  let time = Date.parse('2026-10-21T01:00:00Z');
  const options = { clock: () => time };
  let { server, base } = await startServer(dataDir, options);
  try {
    const account = await register(base, 'budget-owner');
    const garment = await upload(base, account.token);
    const input = { title: '预算控制', brand: '木棉', brief: '自然日常', garment_asset_ids: [garment.id] };
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: input })).body;
    const another = (await request<Project>(base, '/api/projects', { token: account.token, body: input })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    const getMessages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    const setLimit = async (limit: number) => {
      await closeServer(server);
      const file = path.join(dataDir, 'db.json');
      const db = JSON.parse(await readFile(file, 'utf8')) as { users: { id: string; daily_budget_cny?: number }[] };
      db.users.find((user) => user.id === account.user.id)!.daily_budget_cny = limit;
      await writeFile(file, JSON.stringify(db));
      ({ server, base } = await startServer(dataDir, options));
    };
    await setLimit(5.5);
    await send(base, project.id, account.token, { text: '给我三个方向' });
    assert.deepEqual((await getState()).budget, { tier: 'free', daily_budget_cny: 5.5, today_cost_cny: 0, remaining_cny: 1, daily_budget_points: 55, today_cost_points: 0, remaining_points: 10 });
    assert.equal((await request<User>(base, '/api/me', { token: account.token })).body.today_cost_cny, 0, 'queued reservations are not billed as successful usage');
    const otherState = (await request<State>(base, `/api/projects/${another.id}/state`, { token: account.token })).body;
    assert.equal(otherState.budget?.remaining_cny, 1, 'all projects display the same account-wide available balance');
    const competing = await send(base, another.id, account.token, { text: '给我三个方向' });
    assert.equal(competing[0].data.code, 'BUDGET_EXCEEDED', 'queued costs reserve budget across projects');
    time += 250;
    let state = await getState();
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    state = await getState();
    const historyBefore = await getMessages();
    const denied = await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    assert.equal(denied[0].data.code, 'BUDGET_EXCEEDED');
    assert.match(String(denied[0].data.message), /今日点数不够了/);
    assert.deepEqual(await getState(), state);
    assert.deepEqual(await getMessages(), historyBefore);
    await setLimit(6.4);
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    assert.deepEqual((await getState()).budget, { tier: 'free', daily_budget_cny: 6.4, today_cost_cny: 4.5, remaining_cny: 0.4, daily_budget_points: 64, today_cost_points: 45, remaining_points: 4 });
    time += 250;
    state = await getState();
    assert.equal(state.images.length, 3, 'automatic repair must fit the remaining budget');
    assert.equal(state.active_jobs.length, 0);
    assert.equal(state.budget?.today_cost_cny, 6);
    assert.equal(state.budget?.remaining_cny, 0.4);
    const image = state.images[0];
    assert.equal((await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: image.id, instruction: '背景亮一点' } }))[0].data.code, 'BUDGET_EXCEEDED');
    await send(base, project.id, account.token, { action: { type: 'approve_images', image_ids: [image.id] } });
    const noteState = await getState();
    assert.equal(noteState.pending_action?.estimated_cost_cny, 1.5);
    assert.equal((await send(base, project.id, account.token, { action: { type: 'confirm_video', image_id: image.id } }))[0].data.code, 'BUDGET_EXCEEDED');
    assert.deepEqual(await getState(), noteState);
    time += 86_400_000;
    assert.equal((await getState()).budget?.remaining_cny, 6.4);
    await send(base, project.id, account.token, { action: { type: 'confirm_video', image_id: image.id } });
    time += 250;
    state = await getState();
    assert.equal(state.budget?.today_cost_cny, 1.5);
    assert.equal(state.budget?.remaining_cny, 4.9);
    assert.equal(state.cost_cny, 7.5, 'project ledger keeps lifetime spend while daily usage resets');
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('reference ownership, limit and style survive SSE, history and restart; cover anchors the set and edit versions', async () => {
  const dataDir = await temporaryData('outfit-mock-references-');
  let time = Date.parse('2026-10-21T01:00:00Z');
  const options = { clock: () => time };
  let { server, base } = await startServer(dataDir, options);
  try {
    const owner = await register(base, 'reference-owner');
    const other = await register(base, 'reference-other');
    const garment = await upload(base, owner.token);
    const model = await upload(base, owner.token, 'model');
    const references = await Promise.all(Array.from({ length: 4 }, () => upload(base, owner.token, 'reference')));
    const foreign = await upload(base, other.token, 'reference');
    const input = { title: '参考风格合作', brand: '木棉', brief: '日常穿搭', garment_asset_ids: [garment.id], model_asset_id: model.id };
    for (const reference_asset_ids of [null, 'wrong', [42], [foreign.id], [garment.id], [model.id], ['missing'], [references[0].id, references[0].id], references.map((item) => item.id)]) {
      const denied = await request<{ error: { code: string } }>(base, '/api/projects', { token: owner.token, body: { ...input, reference_asset_ids } });
      assert.equal(denied.response.status, 400);
      assert.equal(denied.body.error.code, 'INVALID_REFERENCE_ASSETS');
    }
    assert.deepEqual((await request<Project[]>(base, '/api/projects', { token: owner.token })).body, []);
    const referenceIds = references.slice(0, 3).map((item) => item.id);
    const project = (await request<Project>(base, '/api/projects', { token: owner.token, body: { ...input, reference_asset_ids: referenceIds } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: owner.token })).body;
    const getMessages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: owner.token })).body;
    const stored = async () => JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { assets: { id: string; projectId?: string; source: string; prompt?: string }[] };
    assert.deepEqual(project.reference_asset_ids, referenceIds);
    assert.match(project.brief, /参考图整理要点.*场景.*光线.*构图.*氛围.*配色/);
    assert.deepEqual((await request<Project>(base, `/api/projects/${project.id}`, { token: owner.token })).body.reference_asset_ids, referenceIds);
    assert.deepEqual((await request<Project[]>(base, '/api/projects', { token: owner.token })).body[0].reference_asset_ids, referenceIds);
    const first = await send(base, project.id, owner.token, { text: '请根据参考图给出方向' });
    assert.deepEqual(first.filter((event) => event.type === 'card').map((event) => event.data.type), ['garments', 'references', 'directions']);
    const referenceCard = first.find((event) => event.type === 'card' && event.data.type === 'references')!.data as unknown as { id: string; items: { asset_id: string; url: string; style_tags: string[] }[] };
    assert.deepEqual(referenceCard.items.map((item) => item.asset_id), referenceIds);
    assert.ok(referenceCard.items.every((item) => item.style_tags.length >= 5 && item.url.startsWith(base)));
    assert.equal((await fetch(referenceCard.items[0].url)).status, 200);
    time += 100;
    let state = await getState();
    assert.ok(state.directions.every((direction) => direction.why.includes('参考图风格') && direction.mood.includes('参考图')));
    const previews = (await stored()).assets.filter((asset) => asset.projectId === project.id);
    assert.equal(previews.length, 9);
    assert.ok(previews.every((asset) => /参考图风格.*方向预览/.test(asset.prompt || '')));
    const generatedReference = await request(base, '/api/projects', { token: owner.token, body: { ...input, reference_asset_ids: [previews[0].id] } });
    assert.equal(generatedReference.response.status, 400, 'generated assets cannot be reused as uploaded references');
    await send(base, project.id, owner.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    state = await getState();
    assert.match(state.script!.cover.scene, /参考图风格/);
    assert.ok(state.script!.shots.every((shot) => shot.camera.includes('参考图风格')));
    const confirmed = await send(base, project.id, owner.token, { action: { type: 'confirm_script' } });
    assert.equal(confirmed.filter((event) => event.type === 'job').length, 3);
    time += 35;
    state = await getState();
    assert.equal(state.images[0].status, 'running');
    assert.ok(state.images.slice(1).every((image) => image.status === 'queued' && image.anchor_id === undefined));
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    time += 220;
    state = await getState();
    const cover = state.images[0];
    assert.equal(cover.status, 'succeeded');
    assert.equal(cover.fidelity?.person_score, 92);
    assert.equal(cover.anchor_id, undefined);
    assert.equal(cover.fidelity?.anchor_score, undefined);
    assert.ok(state.images.slice(1).every((image) => image.status === 'queued' && image.anchor_id === cover.id));
    assert.equal(state.active_jobs.length, 2);
    time += 35;
    state = await getState();
    assert.ok(state.images.slice(1).every((image) => image.status === 'running'));
    time += 220;
    state = await getState();
    assert.equal(state.images.length, 4, 'automatic garment repair retains the same cover anchor');
    assert.ok(state.images.slice(1).every((image) => image.anchor_id === cover.id));
    time += 200;
    state = await getState();
    assert.ok(state.images.every((image) => image.status === 'succeeded' && image.fidelity?.person_score === 92));
    assert.ok(state.images.slice(1).every((image) => image.fidelity?.anchor_score === 94));
    assert.match((await getMessages()).at(-1)!.text, /人像一致性 92.*封面一致性 94/);
    const original = state.images[1];
    await send(base, project.id, owner.token, { action: { type: 'edit_image', image_id: original.id, instruction: '背景亮一点' } });
    const editId = (await getState()).images.at(-1)!.id;
    time += 200;
    state = await getState();
    const edited = state.images.find((image) => image.id === editId)!;
    assert.equal(edited.parent_id, original.id);
    assert.equal(edited.anchor_id, cover.id);
    assert.equal(edited.fidelity?.anchor_score, 94);
    assert.equal(edited.fidelity?.person_score, 92);
    await send(base, project.id, owner.token, { action: { type: 'edit_image', image_id: cover.id, instruction: '封面背景亮一点' } });
    time += 200;
    state = await getState();
    assert.equal(state.images.at(-1)!.parent_id, cover.id);
    assert.equal(state.images.at(-1)!.anchor_id, undefined, 'editing the cover must not point its anchor to itself or the edit');
    assert.equal(state.images.find((image) => image.id === original.id)!.anchor_id, cover.id);
    const generated = (await stored()).assets.filter((asset) => asset.projectId === project.id && !previews.some((preview) => preview.id === asset.id));
    assert.ok(generated.every((asset) => asset.prompt?.includes('参考图风格')));
    assert.ok(generated.some((asset) => asset.prompt?.includes(`以封面 ${cover.id} 为锚点`)));
    const before = state.images;
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    assert.deepEqual((await getState()).images.map(({ url: _url, ...image }) => image), before.map(({ url: _url, ...image }) => image));
    const historyCard = (await getMessages()).flatMap((message) => message.cards).find((card) => card.type === 'references') as unknown as typeof referenceCard;
    assert.equal(historyCard.id, referenceCard.id);
    assert.deepEqual(historyCard.items.map((item) => item.asset_id), referenceIds);
    assert.ok(historyCard.items.every((item) => item.url.startsWith(base)), 'history refreshes signed reference URLs after restart');
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('cover failure releases remaining shots without anchors and no-photo references omit person scores', async () => {
  const dataDir = await temporaryData('outfit-mock-anchor-failure-');
  const fixturesDir = path.join(dataDir, 'fixtures');
  await mkdir(fixturesDir);
  const fixture = path.join(fixturesDir, 't-wan-v.jpg');
  await copyFile(path.resolve(import.meta.dirname, '../../docs/spike/t-wan-v.jpg'), fixture);
  let time = Date.parse('2026-10-21T01:00:00Z');
  const { server, base } = await startServer(dataDir, { clock: () => time, fixturesDir });
  try {
    const account = await register(base, 'anchor-fallback');
    const garment = await upload(base, account.token);
    const reference = await upload(base, account.token, 'reference');
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '封面回退', brand: '木棉', brief: '日常穿搭', garment_asset_ids: [garment.id], reference_asset_ids: [reference.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    await send(base, project.id, account.token, { text: '请给出方向' });
    time += 100;
    let state = await getState();
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    await rm(fixture);
    time += 250;
    state = await getState();
    assert.equal(state.images[0].status, 'failed');
    assert.ok(state.images.slice(1).every((image) => image.status === 'queued' && image.anchor_id === undefined));
    await copyFile(path.resolve(import.meta.dirname, '../../docs/spike/t-wan-v.jpg'), fixture);
    time += 250;
    state = await getState();
    assert.ok(state.images.slice(1, 3).every((image) => image.status === 'succeeded' && image.anchor_id === undefined && image.fidelity?.person_score === undefined && image.fidelity?.anchor_score === undefined));
    time += 200;
    state = await getState();
    assert.equal(state.active_jobs.length, 0);
    assert.ok(state.images.every((image) => image.anchor_id === undefined));
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('projects without references or a person keep parallel generation and omit new cards and scores', async () => {
  const dataDir = await temporaryData('outfit-mock-no-reference-');
  let time = Date.parse('2026-10-21T01:00:00Z');
  const { server, base } = await startServer(dataDir, { clock: () => time });
  try {
    const account = await register(base, 'no-reference');
    const garment = await upload(base, account.token);
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '原流程', brand: '木棉', brief: '日常穿搭', garment_asset_ids: [garment.id] } })).body;
    assert.deepEqual(project.reference_asset_ids, []);
    assert.equal(project.brief, '日常穿搭');
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    const events = await send(base, project.id, account.token, { text: '请给出方向' });
    assert.ok(!events.some((event) => event.type === 'card' && event.data.type === 'references'));
    time += 100;
    const state = await getState();
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    time += 35;
    assert.ok((await getState()).images.every((image) => image.status === 'running'));
    time += 220;
    await getState();
    time += 200;
    const completed = await getState();
    assert.ok(completed.images.every((image) => image.anchor_id === undefined && image.fidelity?.person_score === undefined && image.fidelity?.anchor_score === undefined));
    assert.ok(!(await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body.some((message) => /人像一致性|封面一致性/.test(message.text)));
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('project metadata patches validate ownership and lengths, preserve recency and persist pin order', async () => {
  const dataDir = await temporaryData('outfit-project-patch-');
  let time = Date.now();
  let { server, base } = await startServer(dataDir, { clock: () => time });
  try {
    const owner = await register(base, 'pin-owner');
    const other = await register(base, 'pin-other');
    const asset = await upload(base, owner.token);
    type Studio = Project & { title: string; pinned: boolean; updated_at: string };
    const projects: Studio[] = [];
    for (const title of ['旧片场', '中间片场', '新片场']) {
      time += 1000;
      const created = await request<Studio>(base, '/api/projects', { token: owner.token, body: { title, brand: '个人品牌', brief: '测试', garment_asset_ids: [asset.id] } });
      assert.equal(created.body.pinned, false);
      projects.push(created.body);
    }
    const [old, middle, recent] = projects;
    const route = `/api/projects/${old.id}`;
    const patch = (body: Record<string, unknown>, token = owner.token) => request<Studio>(base, route, { method: 'PATCH', token, body });
    assert.equal((await patch({ pinned: true }, other.token)).response.status, 404);
    for (const body of [{ title: '' }, { title: '   ' }, { title: '衣'.repeat(41) }, { title: null }, { pinned: null }, { pinned: 'true' }, { pinned: 1 }, { brief: '越界' }]) {
      assert.equal((await patch(body)).response.status, 422);
    }
    const changed = await patch({ title: ' 🧵'.trim().repeat(40), pinned: true });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.body.updated_at, old.updated_at);
    assert.equal(changed.body.pinned, true);
    assert.equal(Array.from(changed.body.title).length, 40);
    const listIds = async () => (await request<Studio[]>(base, '/api/projects', { token: owner.token })).body.map(item => item.id);
    assert.deepEqual(await listIds(), [old.id, recent.id, middle.id]);
    assert.equal((await patch({ title: '  重命名后的片场  ' })).body.title, '重命名后的片场');
    assert.equal((await patch({})).body.pinned, true);
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, { clock: () => time }));
    assert.deepEqual(await listIds(), [old.id, recent.id, middle.id]);
    assert.equal((await patch({ pinned: false })).body.title, '重命名后的片场');
    assert.deepEqual(await listIds(), [recent.id, middle.id, old.id]);
    await request(base, route, { method: 'DELETE', token: owner.token });
    assert.equal((await patch({ title: '已删除' })).response.status, 404);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('generation and edit traces carry role-labelled inputs, resolved anchors and refreshed history links', async () => {
  const dataDir = await temporaryData('outfit-trace-references-');
  let time = Date.now();
  const { server, base } = await startServer(dataDir, { clock: () => time });
  try {
    const account = await register(base, 'reference-trace');
    const garment = await upload(base, account.token);
    const model = await upload(base, account.token, 'model');
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '参考图透明', brand: '本地品牌', brief: '自然光', garment_asset_ids: [garment.id], model_asset_id: model.id } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    const messages = async () => (await request<Message[]>(base, `/api/projects/${project.id}/messages`, { token: account.token })).body;
    await send(base, project.id, account.token, { text: '开始拍摄' });
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: 'direction_city' } });
    const submitted = await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    const trace = submitted.find(event => event.type === 'trace')!.data as unknown as MessageTrace;
    assert.deepEqual(trace.reference_images!.map(item => item.role), ['模特', '衣服']);
    let state = await getState();
    for (let tick = 0; tick < 8 && state.active_jobs.length; tick += 1) { time += 1000; state = await getState(); }
    const completed = (await messages()).findLast(message => message.trace?.tool === 'generate_images')!;
    const inputs = completed.trace!.reference_images!;
    assert.ok(inputs.some(item => item.role === '封面锚点'));
    assert.equal(new Set(inputs.map(item => item.id)).size, inputs.length);
    for (const item of inputs) assert.equal((await fetch(item.url)).status, 200);
    const original = state.images.find(item => item.anchor_id && item.status === 'succeeded')!;
    const edited = await send(base, project.id, account.token, { action: { type: 'edit_image', image_id: original.id, instruction: '背景亮一点' } });
    const editTrace = edited.find(event => event.type === 'trace')!.data as unknown as MessageTrace;
    assert.ok(editTrace.reference_images!.some(item => item.role === '参考图' && new URL(item.url).pathname === new URL(original.url!).pathname));
    assert.ok(editTrace.reference_images!.some(item => item.role === '封面锚点'));
    time += 86_401_000;
    const refreshed = (await messages()).find(message => message.id === completed.id)!.trace!.reference_images!;
    assert.notEqual(refreshed[0].url, inputs[0].url);
    assert.equal((await fetch(inputs[0].url)).status, 403);
    assert.equal((await fetch(refreshed[0].url)).status, 200);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('quick image tools quote one edit, preserve preset versions and skip checks for double-size upscale', async () => {
  const dataDir = await temporaryData('outfit-mock-quick-tools-');
  let time = Date.now();
  const { server, base } = await startServer(dataDir, { clock: () => time });
  try {
    const { token } = await register(base, 'quick-tools');
    const garment = await upload(base, token);
    const project = (await request<Project>(base, '/api/projects', { token, body: { title: '快捷修片', brand: '日常', brief: '咖啡馆窗光', garment_asset_ids: [garment.id] } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token })).body;
    assert.equal((await request<{ estimate_points: number }>(base, '/api/quotes/edit', { token })).body.estimate_points, 5);
    await send(base, project.id, token, { text: '先给几个方向' });
    await send(base, project.id, token, { action: { type: 'choose_direction', direction_id: (await getState()).directions[0].id } });
    await send(base, project.id, token, { action: { type: 'confirm_script' } });
    time += 250; await getState(); time += 250;
    const original = (await getState()).images[0];
    for (const preset of ['background', 'outpaint', 'upscale'] as const) {
      const action = { type: 'edit_image', image_id: original.id, instruction: '街角', preset, attempt: `quick-${preset}`, ...(preset === 'outpaint' ? { direction: 'top' } : {}) };
      const before = await getState();
      const events = await send(base, project.id, token, { action });
      assert.equal((events.find(item => item.type === 'trace')!.data).tool, preset);
      await send(base, project.id, token, { action });
      assert.equal((await getState()).images.length, before.images.length + 1);
      time += 250;
      const image = (await getState()).images.at(-1)! as Image & { preset: string; direction?: string; upscale_method?: string };
      assert.equal(image.status, 'succeeded');
      assert.equal(image.preset, preset);
      assert.equal(image.parent_id, original.id);
      if (preset === 'background') assert.equal(image.instruction, '只换背景为 街角，人物、服装、姿势、光线方向保持不变');
      if (preset === 'outpaint') assert.equal(image.direction, 'top');
      if (preset === 'upscale') {
        assert.equal(image.edit_check, undefined);
        assert.deepEqual(image.fidelity, original.fidelity);
        assert.equal(image.upscale_method, 'pillow_lanczos');
        const originalSize = await sharp(Buffer.from(await (await fetch(original.url!)).arrayBuffer())).metadata();
        const resultSize = await sharp(Buffer.from(await (await fetch(image.url!)).arrayBuffer())).metadata();
        assert.equal(resultSize.width, originalSize.width! * 2);
        assert.equal(resultSize.height, originalSize.height! * 2);
      } else assert.equal(image.edit_check?.passed, true);
    }
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('garment library exposes bounded tags and owner-only counts before filtered pagination', async () => {
  const dataDir = await temporaryData('outfit-mock-garment-tags-');
  const { server, base } = await startServer(dataDir);
  try {
    const { token } = await register(base, 'garment-tags');
    const other = await register(base, 'other-garment-tags');
    const shirt = await upload(base, token);
    const pants = await upload(base, token);
    await upload(base, other.token);
    const all = (await request<{ items: { id: string; tags: string[] }[]; total: number }>(base, '/api/me/assets?kind=garment', { token })).body;
    assert.equal(all.total, 2);
    assert.equal(all.items.find(item => item.id === shirt.id)!.tags.length, 6);
    const counts = (await request<{ items: { tag: string; count: number }[] }>(base, '/api/me/assets/tags?kind=garment', { token })).body.items;
    assert.equal(counts.find(item => item.tag === '衬衫')!.count, 1);
    assert.equal(counts.find(item => item.tag === '简约')!.count, 2);
    const page = (await request<{ items: { id: string; tags: string[] }[]; total: number }>(base, '/api/me/assets?kind=garment&tag=牛仔裤&limit=1', { token })).body;
    assert.equal(page.total, 1);
    assert.deepEqual(page.items.map(item => item.id), [pants.id]);
    const empty = (await request(base, '/api/me/assets?kind=garment&tag=冬', { token })).body;
    assert.deepEqual(empty, { items: [], total: 0 });
    const second = (await request<{ items: unknown[]; total: number }>(base, '/api/me/assets?kind=garment&tag=简约&limit=1&offset=1', { token })).body;
    assert.equal(second.total, 2);
    assert.equal(second.items.length, 1);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('three previews update independently; one retry survives restart and selected mood reaches the cover', async () => {
  const dataDir = await temporaryData('outfit-three-previews-');
  const fixturesDir = path.join(dataDir, 'fixtures');
  await mkdir(fixturesDir);
  let time = Date.now();
  const options = { clock: () => time, fixturesDir };
  let { server, base } = await startServer(dataDir, options);
  try {
    const account = await register(base, 'three-previews');
    const garment = await upload(base, account.token);
    const model = await upload(base, account.token, 'model');
    const project = (await request<Project>(base, '/api/projects', { token: account.token, body: { title: '三张灵感', brand: '自由创作', brief: '咖啡馆自然光', garment_asset_ids: [garment.id], model_asset_id: model.id } })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, { token: account.token })).body;
    await send(base, project.id, account.token, { text: '找方向' });
    let state = await getState();
    assert.equal(state.active_jobs.length, 9);
    assert.ok(state.directions.every(direction => direction.previews?.length === 3));
    time += 250;
    state = await getState();
    assert.ok(state.directions.every(direction => direction.previews?.every(preview => preview.status === 'failed')));
    await copyFile(path.resolve(import.meta.dirname, '../../docs/spike/t-wan-v.jpg'), path.join(fixturesDir, 't-wan-v.jpg'));
    const direction = state.directions[0];
    const preview = direction.previews![2];
    const action = { type: 'retry_preview', direction_id: direction.id, preview_id: preview.id, attempt: 'single-retry' };
    await send(base, project.id, account.token, { action });
    await send(base, project.id, account.token, { action });
    assert.equal((await getState()).active_jobs.length, 1);
    await closeServer(server);
    ({ server, base } = await startServer(dataDir, options));
    time += 250;
    state = await getState();
    assert.deepEqual(state.directions[0].previews!.map(item => item.status), ['failed', 'failed', 'succeeded']);
    assert.ok(state.directions[0].previews![2].url);
    await send(base, project.id, account.token, { action });
    assert.equal((await getState()).active_jobs.length, 0);
    const stored = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { projects: { state: State }[]; jobs: { directionId?: string; previewId?: string; attempt?: string; result_asset_id?: string; reference_asset_ids?: string[]; imageId?: string }[] };
    assert.equal(stored.jobs.length, 10);
    const selectedAsset = stored.jobs.find(job => job.attempt === action.attempt)!.result_asset_id;
    await send(base, project.id, account.token, { action: { type: 'choose_direction', direction_id: direction.id, preview_id: preview.id } });
    state = await getState();
    assert.match(state.script!.shots[0].camera, /坐姿侧光/);
    await send(base, project.id, account.token, { action: { type: 'confirm_script' } });
    const confirmed = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as typeof stored;
    const cover = confirmed.jobs.find(job => job.imageId === confirmed.projects[0].state.images[0].id)!;
    assert.deepEqual(cover.reference_asset_ids, [garment.id, selectedAsset, model.id]);
  } finally { await closeServer(server); await rm(dataDir, { recursive: true, force: true }); }
});
