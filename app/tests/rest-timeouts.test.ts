import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiError, REST_TIMEOUT_MS } from '../src/api/client';
import type { CreateProjectInput, Project } from '../src/api/types';
import { checkProjectCreation, createProjectWithRecovery, projectCreationRecoveryText } from '../src/lib/projectCreation';

const input: CreateProjectInput = { title: '秋日合作', brand: '品牌', brief: '自然一点', garment_asset_ids: ['garment-1'] };
const project: Project = { id: 'created-on-server', title: input.title, brand: input.brand, brief: input.brief, stage: 'brief', created_at: '', updated_at: '' };

test('REST defaults classify reads at 20 s, writes at 60 s, and uploads at 120 s without replay', async context => {
  assert.deepEqual(REST_TIMEOUT_MS, { read: 20_000, write: 60_000, upload: 120_000 });
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
    delays.push(delay);
    return originalSetTimeout(callback, 1);
  }) as typeof setTimeout);
  const requests: { method: string; signal: AbortSignal }[] = [];
  const client = new ApiClient({ baseUrl: 'http://localhost:19301', fetchImpl: (async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    requests.push({ method: init?.method ?? 'GET', signal });
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }) as typeof fetch });
  for (const request of [
    () => client.projects(),
    () => client.me(),
    () => client.createProject(input),
    () => client.patchMe({ nickname: '新昵称' }),
    () => client.deleteProject('p1'),
    () => client.login({ username: 'gary', password: 'password1' }),
    () => client.uploadAsset(new File(['image'], 'shirt.jpg', { type: 'image/jpeg' }), 'garment'),
  ]) await assert.rejects(request(), (error: unknown) => error instanceof ApiError && error.code === 'TIMEOUT');
  assert.deepEqual(delays, [20_000, 20_000, 60_000, 60_000, 60_000, 60_000, 120_000]);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'GET', 'POST', 'PATCH', 'DELETE', 'POST', 'POST']);
  assert.equal(requests.every(request => request.signal.aborted), true);
  assert.equal(requests.length, 7, 'a timed-out write or upload must never be replayed');
});

test('REST timeout also covers an interrupted response body and aborts its controller', async () => {
  let signal: AbortSignal | null | undefined;
  let reading = false;
  const client = new ApiClient({ baseUrl: 'http://localhost:19301', restTimeoutMs: { read: 5 }, fetchImpl: (async (_url, init) => {
    signal = init?.signal;
    return { status: 200, ok: true, text: () => { reading = true; return new Promise<string>(() => undefined); } } as Response;
  }) as typeof fetch });
  await assert.rejects(client.projects(), (error: unknown) => error instanceof ApiError && error.code === 'TIMEOUT' && /重试/.test(error.message));
  assert.equal(reading, true);
  assert.equal(signal?.aborted, true);
});

test('creation success does not make an extra list request', async () => {
  const calls: string[] = [];
  assert.deepEqual(await createProjectWithRecovery({
    createProject: async submitted => { calls.push('create'); assert.deepEqual(submitted, input); return project; },
    projects: async () => { calls.push('list'); return []; },
  }, input), { kind: 'created', project });
  assert.deepEqual(calls, ['create']);
});

test('timed-out creation refreshes the list and requires a user decision instead of creating again', async () => {
  const calls: string[] = [];
  const api = {
    createProject: async () => { calls.push('create'); throw new ApiError('TIMEOUT', '等待超时'); },
    projects: async () => { calls.push('list'); return [project, { ...project, id: 'different-brief', brief: '其他需求' }, { ...project, id: 'different-brand', brand: '别的品牌' }]; },
  };
  const result = await createProjectWithRecovery(api, input);
  assert.equal(result.kind, 'uncertain');
  if (result.kind !== 'uncertain') throw new Error('创建结果需要人工确认');
  assert.deepEqual(result.recovery.projects, [project]);
  assert.match(projectCreationRecoveryText(result.recovery), /先打开确认/);
  await checkProjectCreation(api, input);
  assert.deepEqual(calls, ['create', 'list', 'list'], 'checking again only refreshes; it cannot replay creation');
});

test('empty recovery list permits an explicit rebuild decision; failed refresh keeps creation blocked', async () => {
  for (const failRefresh of [false, true]) {
    let creates = 0;
    const result = await createProjectWithRecovery({
      createProject: async () => { creates += 1; throw new ApiError('TIMEOUT', '等待超时'); },
      projects: async () => { if (failRefresh) throw new ApiError('NETWORK_ERROR', '离线'); return []; },
    }, input);
    assert.equal(result.kind, 'uncertain');
    if (result.kind !== 'uncertain') throw new Error('创建结果需要人工确认');
    assert.deepEqual(result.recovery.projects, failRefresh ? null : []);
    assert.match(projectCreationRecoveryText(result.recovery), failRefresh ? /先再查一次/ : /确认重新新建/);
    assert.equal(creates, 1);
  }
});

test('ordinary creation errors preserve the error without retry or recovery side effects', async () => {
  let lists = 0;
  const failure = new ApiError('VALIDATION_ERROR', '项目名不正确', 400);
  await assert.rejects(createProjectWithRecovery({
    createProject: async () => { throw failure; },
    projects: async () => { lists += 1; return []; },
  }, input), failure);
  assert.equal(lists, 0);
});
