import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MockServerOptions } from '../mock-server/index.mjs';

interface Image { id: string; version: number; status: string; shot_id: string; edit_check?: { passed: boolean } }
interface State {
  stage: string; mode: 'guided' | 'auto'; style_tags: string[];
  auto?: { active: boolean; step: string; label: string; started_at: string; estimate_points: number };
  pending_action: { type: string; estimated_cost_cny?: number; estimated_cost_points?: number } | null;
  active_jobs: { id: string; status: string }[];
  directions: { id: string; why: string; recommended?: boolean }[];
  script?: { status: string; shots: { camera: string }[] };
  images: Image[]; note?: { image_ids: string[]; cost_cny: number; cost_points: number };
  cost_cny: number; cost_points: number;
  budget: { daily_budget_cny: number; daily_budget_points: number; today_cost_cny: number; today_cost_points: number; remaining_cny: number; remaining_points: number };
}
interface Project { id: string; brief: string; mode: string; style_tags: string[]; progress: { status: string; label: string; running: number; total: number; updated_at: string } }
interface Message { role: string; text: string; trace?: { cost_cny: number; cost_points: number }; cards: { type: string; regenerate_estimate_cny?: number; regenerate_estimate_points?: number; cost_cny?: number; cost_points?: number }[] }
interface Stored { users: { daily_budget_cny?: number }[]; projects: { mode: string; state: State; messages: Message[] }[] }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(dataDir: string, options: MockServerOptions = {}) {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const server = await createMockServer({ dataDir, tokenDelayMs: 0, previewDelayMs: 10, previewStaggerMs: 0, imageDelayMs: 10, imageStaggerMs: 0, editDelayMs: 10, videoDelayMs: 10, runningDelayMs: 2, autoStepDelayMs: 20, workerIntervalMs: 5, ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function request<T>(base: string, route: string, token?: string, body?: Record<string, unknown> | FormData) {
  const form = body instanceof FormData;
  const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as T };
}
async function setup(base: string) {
  const { body: account } = await request<{ token: string; user: { daily_budget_cny: number; daily_budget_points: number } }>(base, '/api/auth/register', undefined, { username: 'round9-owner', password: 'test-password' });
  assert.equal(account.user.daily_budget_points, account.user.daily_budget_cny * 10);
  const form = new FormData();
  const bytes = await readFile(path.resolve(import.meta.dirname, '../../docs/spike/inputs.jpg'));
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'garment.jpg');
  form.append('kind', 'garment');
  const { body: asset } = await request<{ id: string }>(base, '/api/assets', account.token, form);
  return { token: account.token, input: { title: '一组新片', brand: '自由创作', brief: '自然日常，保留这句原文', garment_asset_ids: [asset.id] } };
}
async function send(base: string, id: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/projects/${id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!stream.includes('event: error'), stream);
  return stream;
}

test('round nine validates project mode/style, preserves the brief, and exposes exact point aliases and quote', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'outfit-round9-contract-'));
  const { server, base } = await start(dataDir);
  try {
    const { token, input } = await setup(base);
    for (const invalid of [{ mode: 'fast' }, { mode: null }, { style_tags: '松弛通勤' }, { style_tags: Array(7).fill('松弛通勤') }, { style_tags: ['十三个字的风格描述不能提交通过'] }, { style_tags: [42] }, { style_tags: [''] }]) {
      assert.equal((await request(base, '/api/projects', token, { ...input, ...invalid })).status, 400);
    }
    const quote = (await request<{ estimate_points: number; breakdown: { label: string; points: number }[] }>(base, '/api/quotes/auto', token)).body;
    assert.equal(quote.estimate_points, 48);
    assert.deepEqual(quote.breakdown.map((item) => item.points), [15, 18, 15]);
    assert.equal(quote.breakdown.reduce((sum, item) => sum + item.points, 0), quote.estimate_points);
    const { body: project } = await request<Project>(base, '/api/projects', token, { ...input, style_tags: ['松弛通勤', '街头胶片'] });
    assert.equal(project.mode, 'guided');
    assert.equal(project.brief, input.brief);
    assert.equal(project.progress.status, 'idle');
    assert.deepEqual(project.style_tags, ['松弛通勤', '街头胶片']);
    const stream = await send(base, project.id, token, { text: '请给我方向' });
    assert.match(stream, /regenerate_estimate_points/);
    let state = (await request<State>(base, `/api/projects/${project.id}/state`, token)).body;
    assert.equal(state.mode, 'guided');
    assert.equal(state.auto, undefined);
    assert.equal(state.budget.daily_budget_points, 200);
    assert.equal(state.budget.remaining_points, state.budget.remaining_cny * 10);
    assert.equal(state.directions.filter((direction) => direction.recommended).length, 1);
    assert.match(state.directions.find((direction) => direction.recommended)!.id, /work/);
    assert.ok(state.directions.every((direction) => direction.why.includes('街头胶片')));
    await send(base, project.id, token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    state = (await request<State>(base, `/api/projects/${project.id}/state`, token)).body;
    assert.ok(state.script!.shots.every((shot) => shot.camera.includes('松弛通勤')));
    assert.equal(state.pending_action?.estimated_cost_cny, 1.8);
    assert.equal(state.pending_action?.estimated_cost_points, 18);
    const messages = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, token)).body;
    assert.ok(messages.filter((message) => message.trace).every((message) => message.trace!.cost_points === message.trace!.cost_cny * 10));
  } finally { await close(server); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('round nine auto worker completes every step without frontend requests, with proactive messages and no confirmations', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'outfit-round9-auto-'));
  const { server, base } = await start(dataDir);
  try {
    const { token, input } = await setup(base);
    const project = (await request<Project>(base, '/api/projects', token, { ...input, mode: 'auto', style_tags: ['法式慵懒'] })).body;
    const seen = new Set<string>();
    let stored: Stored | undefined;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      stored = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as Stored;
      const state = stored.projects[0].state;
      assert.equal(state.pending_action, null);
      seen.add(state.auto!.step);
      if (state.auto?.step === 'done') break;
      await wait(5);
    }
    assert.deepEqual([...seen], ['directions', 'script', 'images', 'note', 'video', 'done']);
    assert.equal(stored!.projects[0].state.auto?.active, false);
    assert.ok(stored!.projects[0].messages.every((message) => message.role === 'assistant'), 'automatic defaults do not fabricate user messages');
    const state = (await request<State>(base, `/api/projects/${project.id}/state`, token)).body;
    assert.equal(state.stage, 'done');
    assert.equal(state.mode, 'auto');
    assert.equal(state.cost_points, state.cost_cny * 10);
    assert.equal(state.note?.cost_points, state.note!.cost_cny * 10);
    assert.equal(state.note!.image_ids.length, 3);
    assert.ok(state.note!.image_ids.every((id) => state.images.find((image) => image.id === id)?.version === 1));
    assert.equal(state.images.find((image) => image.id === state.note!.image_ids[0])?.shot_id, 'shot_1');
    const messages = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, token)).body;
    for (const phrase of ['先按你的风格', '整理成拍摄脚本', '开始正式出图', '正在整理标题', '5 秒短视频', '全套出好了']) assert.ok(messages.some((message) => message.text.includes(phrase)), phrase);
    const list = (await request<Project[]>(base, '/api/projects', token)).body;
    assert.equal(list[0].progress.status, 'done');
    assert.equal(list[0].progress.label, '全套已出好');
  } finally { await close(server); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('round nine takeover keeps queued jobs and waits at the next direction or script checkpoint', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'outfit-round9-takeover-'));
  let time = Date.parse('2026-10-21T01:00:00Z');
  const { server, base } = await start(dataDir, { clock: () => time, autoStepDelayMs: 100, previewDelayMs: 50 });
  try {
    const { token, input } = await setup(base);
    const first = (await request<Project>(base, '/api/projects', token, { ...input, mode: 'auto' })).body;
    const before = (await request<State>(base, `/api/projects/${first.id}/state`, token)).body;
    assert.equal(before.auto?.step, 'directions');
    const ids = before.active_jobs.map((job) => job.id);
    let state = (await request<State>(base, `/api/projects/${first.id}/mode`, token, { mode: 'guided' })).body;
    assert.equal(state.mode, 'guided');
    assert.equal(state.auto?.active, false);
    assert.equal(state.pending_action, null);
    assert.deepEqual(state.active_jobs.map((job) => job.id), ids);
    time += 101;
    state = (await request<State>(base, `/api/projects/${first.id}/state`, token)).body;
    assert.equal(state.pending_action?.type, 'choose_direction');
    assert.equal(state.images.length, 0);
    assert.equal(state.active_jobs.length, 0);
    const second = (await request<Project>(base, '/api/projects', token, { ...input, mode: 'auto' })).body;
    await send(base, second.id, token, { text: '我想保留自然的动作' });
    const chatMessages = (await request<Message[]>(base, `/api/projects/${second.id}/messages`, token)).body;
    assert.match(chatMessages.at(-1)!.text, /片子正在继续准备/);
    time += 101;
    state = (await request<State>(base, `/api/projects/${second.id}/state`, token)).body;
    assert.equal(state.auto?.step, 'script');
    assert.equal(state.pending_action, null);
    state = (await request<State>(base, `/api/projects/${second.id}/mode`, token, { mode: 'guided' })).body;
    assert.equal(state.pending_action?.type, 'confirm_script');
    time += 1_000;
    state = (await request<State>(base, `/api/projects/${second.id}/state`, token)).body;
    assert.equal(state.stage, 'script');
    assert.equal(state.images.length, 0);
    const projects = (await request<Project[]>(base, '/api/projects', token)).body;
    assert.equal(projects.find((project) => project.id === second.id)?.progress.label, '等你确认脚本');
    assert.equal((await request(base, `/api/projects/${second.id}/mode`, token, { mode: 'auto' })).status, 400);
  } finally { await close(server); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('round nine auto stops with a useful proactive message for task failure and insufficient points', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'outfit-round9-failure-'));
  let time = Date.parse('2026-10-21T01:00:00Z');
  let { server, base } = await start(dataDir, { clock: () => time, fixturesDir: path.join(dataDir, 'missing-fixtures') });
  try {
    const { token, input } = await setup(base);
    const project = (await request<Project>(base, '/api/projects', token, { ...input, mode: 'auto' })).body;
    time += 100;
    let state = (await request<State>(base, `/api/projects/${project.id}/state`, token)).body;
    assert.equal(state.mode, 'guided');
    assert.equal(state.auto?.active, false);
    assert.equal(state.pending_action?.type, 'choose_direction');
    const messages = (await request<Message[]>(base, `/api/projects/${project.id}/messages`, token)).body;
    assert.match(messages.at(-1)!.text, /停在.*有生成任务没有完成.*沉浸编导.*继续/);
    assert.equal((await request<Project[]>(base, '/api/projects', token)).body[0].progress.status, 'failed');
    await close(server);
    const filename = path.join(dataDir, 'db.json');
    const db = JSON.parse(await readFile(filename, 'utf8')) as Stored;
    db.users[0].daily_budget_cny = 0;
    await writeFile(filename, JSON.stringify(db));
    ({ server, base } = await start(dataDir, { clock: () => time }));
    const denied = (await request<Project>(base, '/api/projects', token, { ...input, mode: 'auto' })).body;
    state = (await request<State>(base, `/api/projects/${denied.id}/state`, token)).body;
    assert.equal(state.mode, 'guided');
    assert.equal(state.active_jobs.length, 0);
    const stopped = (await request<Message[]>(base, `/api/projects/${denied.id}/messages`, token)).body;
    assert.match(stopped.at(-1)!.text, /今日点数不够了，明天 00:00 恢复/);
  } finally { await close(server); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('round nine image takeover survives restart, preserves every task, and maps waiting/ready/video progress', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'outfit-round9-progress-'));
  let time = Date.parse('2026-10-21T01:00:00Z');
  const options = { clock: () => time };
  let { server, base } = await start(dataDir, options);
  try {
    const { token, input } = await setup(base);
    const project = (await request<Project>(base, '/api/projects', token, { ...input, mode: 'auto' })).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, token)).body;
    const progress = async () => (await request<Project[]>(base, '/api/projects', token)).body.find((item) => item.id === project.id)!.progress;
    time += 21;
    assert.equal((await getState()).auto?.step, 'script');
    time += 21;
    let state = await getState();
    assert.equal(state.auto?.step, 'images');
    const jobs = state.active_jobs.map((job) => job.id);
    state = (await request<State>(base, `/api/projects/${project.id}/mode`, token, { mode: 'guided' })).body;
    assert.deepEqual(state.active_jobs.map((job) => job.id), jobs);
    assert.equal(state.pending_action, null);
    await close(server);
    ({ server, base } = await start(dataDir, options));
    assert.deepEqual((await getState()).active_jobs.map((job) => job.id), jobs);
    time += 21;
    state = await getState();
    assert.equal(state.active_jobs.length, 1, 'the automatic repair already belonging to this batch is retained');
    assert.equal(state.pending_action, null);
    assert.equal((await progress()).status, 'generating');
    assert.equal((await progress()).label, '改图中');
    time += 21;
    state = await getState();
    assert.equal(state.pending_action?.type, 'approve_images');
    assert.equal((await progress()).status, 'waiting_you');
    const selected = state.images.filter((image) => image.version === 1).map((image) => image.id);
    await send(base, project.id, token, { action: { type: 'approve_images', image_ids: selected } });
    assert.equal((await progress()).status, 'ready');
    assert.equal((await progress()).label, '笔记已就绪，等你看');
    await send(base, project.id, token, { action: { type: 'confirm_video', image_id: selected[0] } });
    assert.equal((await progress()).status, 'generating');
    assert.equal((await progress()).label, '视频生成中');
    time += 21;
    state = await getState();
    assert.equal(state.stage, 'done');
    assert.equal(state.pending_action, null);
    assert.equal((await progress()).status, 'done');
  } finally { await close(server); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('round nine progress ignores replaced previews and failed image/video attempts after successful retries', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'outfit-round9-progress-retry-'));
  const fixturesDir = path.join(dataDir, 'fixtures');
  await mkdir(fixturesDir);
  const source = path.resolve(import.meta.dirname, '../../docs/spike');
  const imageFixture = path.join(fixturesDir, 't-wan-v.jpg');
  await copyFile(path.join(source, 't-wan-v.jpg'), imageFixture);
  let time = Date.parse('2026-10-21T01:00:00Z');
  const { server, base } = await start(dataDir, { clock: () => time, fixturesDir });
  try {
    const { token, input } = await setup(base);
    const project = (await request<Project>(base, '/api/projects', token, input)).body;
    const getState = async () => (await request<State>(base, `/api/projects/${project.id}/state`, token)).body;
    const progress = async () => (await request<Project[]>(base, '/api/projects', token)).body[0].progress;
    await send(base, project.id, token, { text: '先给我三个方向' });
    await send(base, project.id, token, { text: '换一组' });
    assert.equal((await progress()).status, 'generating');
    assert.equal((await progress()).total, 3, 'superseded preview jobs are excluded from the current batch');
    time += 21;
    let state = await getState();
    assert.equal((await progress()).status, 'waiting_you');
    assert.equal((await progress()).label, '等你挑个方向');
    assert.equal((await progress()).total, 3);
    await send(base, project.id, token, { action: { type: 'choose_direction', direction_id: state.directions[0].id } });
    await send(base, project.id, token, { action: { type: 'confirm_script' } });
    await rm(imageFixture);
    time += 21;
    state = await getState();
    assert.ok(state.images.every((image) => image.status === 'failed'));
    assert.equal((await progress()).status, 'failed');
    await copyFile(path.join(source, 't-wan-v.jpg'), imageFixture);
    await send(base, project.id, token, { text: '重试没有完成的图片' });
    assert.equal((await progress()).total, 3);
    time += 21;
    await getState();
    time += 21;
    state = await getState();
    assert.ok(state.images.every((image) => image.status === 'succeeded'));
    assert.equal((await progress()).status, 'waiting_you');
    const selected = state.images.filter((image) => image.version === 1).map((image) => image.id);
    await send(base, project.id, token, { action: { type: 'approve_images', image_ids: selected } });
    assert.equal((await progress()).status, 'ready');
    await send(base, project.id, token, { action: { type: 'confirm_video', image_id: selected[0] } });
    time += 21;
    state = await getState();
    assert.equal(state.stage, 'note');
    assert.equal((await progress()).status, 'failed');
    await copyFile(path.join(source, 'v-wan.mp4'), path.join(fixturesDir, 'v-wan.mp4'));
    await send(base, project.id, token, { action: { type: 'confirm_video', image_id: selected[0] } });
    assert.equal((await progress()).status, 'generating');
    assert.equal((await progress()).total, 1, 'the replaced failed video is excluded');
    time += 21;
    state = await getState();
    assert.equal(state.stage, 'done');
    assert.equal((await progress()).status, 'done');
    assert.equal((await progress()).label, '全套已出好');
    assert.equal((await progress()).total, 1);
  } finally { await close(server); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
