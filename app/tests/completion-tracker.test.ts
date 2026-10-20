import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job, ProjectState } from '../src/api/types';
import { checkGeneration, completedGroups, createGenerationRuntime, deliverCompletion, notificationOwner, notificationProject, parseSavedGenerations, trackState, type Completion, type NotificationSession } from '../src/lib/completionTracker';

const job = (id: string, kind: Job['kind'] = 'image', status: Job['status'] = 'running'): Job => ({ id, project_id: 'project_1', kind, status, created_at: '2026-10-21T01:00:00Z', updated_at: '2026-10-21T01:00:00Z', url: 'https://local.invalid/media?sig=private' });
const state = (jobs: Job[] = [], patch: Partial<ProjectState> = {}): ProjectState => ({ stage: 'images', garments: [], directions: [], images: jobs.filter(item => item.kind === 'image').map(item => ({ id: `image_${item.id}`, shot_id: item.id, version: 1, status: item.status })), active_jobs: jobs, ...patch });
const example: Completion = { projectId: 'project_1', title: '春日合作', kind: 'image', jobIds: ['job_1'], body: '图片完成' };
const fixtureSession = (api: NotificationSession['api'], userId = 'user_1', baseUrl = 'http://local.invalid'): NotificationSession => ({ api, userId, baseUrl, token: `token-${userId}` });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('tracker excludes preview jobs across stage changes and strips signed media from persisted progress', () => {
  const preview = job('preview');
  let watched = trackState(undefined, 'project_1', '春日合作', state([preview], { stage: 'direction', images: [] }));
  assert.deepEqual(watched.jobs, []);
  watched = trackState(watched, 'project_1', '合作项目', state([preview], { stage: 'script', images: [] }));
  assert.equal(watched.title, '春日合作');
  const image = { ...job('shot'), created_at: '2026-10-21T01:01:00Z' };
  watched = trackState(watched, 'project_1', '合作项目', state([preview, image], { images: [{ id: 'image', shot_id: 'shot', status: 'running', version: 1 }] }));
  assert.deepEqual(watched.jobs.map(item => item.id), ['shot']);
  assert.ok(!JSON.stringify(watched).includes('sig='));
  const finished = completedGroups(watched, [{ ...image, status: 'succeeded' }]);
  assert.ok(!JSON.stringify(finished.watched).includes('sig='));
  assert.equal(finished.completions.length, 1);
});

test('batch waits for dynamic automatic repairs, announces once, and supports later edit/image/video rounds', () => {
  const first = job('first');
  const repair = job('repair', 'edit');
  let watched = trackState(undefined, 'project_1', '合作', state([first]));
  watched = trackState(watched, watched.id, watched.title, state([repair], { images: [{ id: 'image', shot_id: 'first', status: 'succeeded', version: 1 }, { id: 'repair_image', shot_id: 'first', parent_id: 'image', status: 'running', version: 2 }] }));
  let result = completedGroups(watched, [{ ...first, status: 'succeeded' }, repair]);
  assert.deepEqual(result.completions, []);
  result = completedGroups(result.watched, [{ ...repair, status: 'succeeded' }]);
  assert.equal(result.completions.length, 1);
  assert.equal(result.completions[0].kind, 'image');
  assert.deepEqual(result.completions[0].jobIds, ['first', 'repair']);
  assert.deepEqual(completedGroups(result.watched, []).completions, []);
  watched = trackState(result.watched, watched.id, watched.title, state([job('manual', 'edit')]));
  result = completedGroups(watched, [job('manual', 'edit', 'succeeded')]);
  assert.equal(result.completions[0].kind, 'edit');
  watched = trackState(result.watched, watched.id, watched.title, state([job('next'), job('video', 'video')]));
  result = completedGroups(watched, [job('next', 'image', 'failed'), job('video', 'video', 'succeeded')]);
  assert.deepEqual(result.completions.map(item => item.kind), ['video']);
  assert.deepEqual(completedGroups(result.watched, []).completions, []);
});

test('delivery stays in-app in foreground, silently skips denied permission, and rechecks visibility/ownership after awaits', async () => {
  let foreground = true;
  let current = true;
  let permissionCalls = 0;
  const notices: Completion[] = [];
  const scheduled: Completion[] = [];
  let granted = false;
  const delivery = { isForeground: () => foreground, isCurrent: () => current, foreground: (value: Completion) => notices.push(value), schedule: async (value: Completion) => { scheduled.push(value); }, permissionGranted: async () => { permissionCalls += 1; return granted; } };
  await deliverCompletion(example, 'owner', delivery);
  assert.equal(permissionCalls, 0);
  assert.equal(notices.length, 1);
  foreground = false;
  await deliverCompletion(example, 'owner', delivery);
  assert.equal(scheduled.length, 0);
  granted = true;
  await deliverCompletion(example, 'owner', delivery);
  assert.equal(scheduled.length, 1);
  const permission = deferred<boolean>();
  const pending = deliverCompletion(example, 'owner', { ...delivery, permissionGranted: () => permission.promise });
  foreground = true;
  permission.resolve(true);
  await pending;
  assert.equal(notices.length, 2);
  assert.equal(scheduled.length, 1);
  foreground = false;
  const secondPermission = deferred<boolean>();
  const stale = deliverCompletion(example, 'owner', { ...delivery, permissionGranted: () => secondPermission.promise });
  current = false;
  secondPermission.resolve(true);
  await stale;
  assert.equal(scheduled.length, 1);
});

test('poll discovers an automatic repair queued between state and job responses before announcing the batch', async () => {
  const original = job('first');
  let stateCalls = 0;
  const api = {
    state: async () => ++stateCalls === 1 ? state([original]) : state([job('repair', 'edit')], { images: [{ id: 'first_image', shot_id: 'first', status: 'succeeded', version: 1 }, { id: 'repair_image', shot_id: 'first', parent_id: 'first_image', status: 'running', version: 2 }] }),
    job: async () => job('first', 'image', 'succeeded'),
  };
  const result = await checkGeneration(api, trackState(undefined, 'project_1', '合作', state([original])));
  assert.equal(stateCalls, 2);
  assert.deepEqual(result.completions, []);
  assert.ok(result.watched.jobs.some(item => item.id === 'repair' && item.status === 'running'));
});

test('injectable runtime restores pending work, persists deduplication before delivering, retries delivery failures, and drops deleted projects', async () => {
  let stored: string | null = null;
  let complete = false;
  let deleted = false;
  let shouldFail = true;
  let requests = 0;
  const delivered: Completion[] = [];
  const api = {
    state: async () => { requests += 1; if (deleted) throw Object.assign(new Error('deleted'), { status: 404 }); return state(complete ? [] : [job('first')]); },
    job: async () => job('first', 'image', complete ? 'succeeded' : 'running'),
  };
  const dependencies = {
    load: async () => stored,
    save: async (value: string | null) => { stored = value; },
    deliver: async (completion: Completion) => {
      assert.ok(parseSavedGenerations(stored)?.projects[0].announced.includes('first'));
      if (shouldFail) { shouldFail = false; throw new Error('OS unavailable'); }
      delivered.push(completion);
    },
  };
  const initial = createGenerationRuntime(dependencies);
  await initial.configure(fixtureSession(api));
  await initial.observe('project_1', '春日合作', state([job('first')]));
  assert.ok(!stored!.includes('token-'));
  assert.ok(!stored!.includes('sig='));
  const restored = createGenerationRuntime(dependencies);
  await restored.configure(fixtureSession(api));
  complete = true;
  await restored.poll();
  assert.equal(delivered.length, 0);
  assert.deepEqual(parseSavedGenerations(stored)?.projects[0].announced, []);
  await restored.poll();
  assert.equal(delivered.length, 1);
  await restored.poll();
  assert.equal(delivered.length, 1);
  const afterRestart = createGenerationRuntime(dependencies);
  await afterRestart.configure(fixtureSession(api));
  await afterRestart.poll();
  assert.equal(delivered.length, 1);
  complete = false;
  await restored.observe('deleted', '删除项目', state([job('new')]));
  deleted = true;
  await restored.poll();
  assert.ok(!parseSavedGenerations(stored)?.projects.some(project => project.id === 'deleted'));
  const before = requests;
  await restored.poll();
  assert.equal(requests, before);
});

test('runtime ignores delayed old-account results and never restores another server or account watch list', async () => {
  let stored: string | null = null;
  const waiting = deferred<ProjectState>();
  const entered = deferred<void>();
  const delivered: string[] = [];
  const api = { state: async () => { entered.resolve(); return waiting.promise; }, job: async () => job('first', 'image', 'succeeded') };
  const runtime = createGenerationRuntime({ load: async () => stored, save: async value => { stored = value; }, deliver: async (_completion, owner) => { delivered.push(owner); } });
  const alice = fixtureSession(api, 'alice');
  await runtime.configure(alice);
  await runtime.observe('project_1', 'Alice的项目', state([job('first')]));
  const pending = runtime.poll();
  await entered.promise;
  const bob = fixtureSession(api, 'bob');
  const switched = runtime.configure(bob);
  waiting.resolve(state());
  await Promise.all([pending, switched]);
  assert.deepEqual(delivered, []);
  assert.equal(parseSavedGenerations(stored)?.owner, notificationOwner(bob));
  assert.deepEqual(parseSavedGenerations(stored)?.projects, []);
  await runtime.observe('project_1', 'Bob的项目', state([job('bob-job')]));
  await runtime.configure(fixtureSession(api, 'bob', 'http://another.invalid'));
  assert.deepEqual(parseSavedGenerations(stored)?.projects, []);
  await runtime.configure(null);
  assert.equal(stored, null);
  assert.equal(notificationProject({ owner: notificationOwner(alice), projectId: 'project_1' }, notificationOwner(bob)), undefined);
  assert.equal(notificationProject(undefined, notificationOwner(bob)), undefined);
  assert.equal(notificationProject({ owner: notificationOwner(bob), projectId: '../bad' }, notificationOwner(bob)), undefined);
  assert.equal(notificationProject({ owner: notificationOwner(bob), projectId: 'project_1' }, notificationOwner(bob)), 'project_1');
  assert.equal(parseSavedGenerations('{bad-json'), undefined);
});
