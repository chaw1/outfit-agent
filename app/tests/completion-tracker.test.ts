import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job, ProjectState } from '../src/api/types';
import { appendRecentCompletions, checkGeneration, completedGroups, createGenerationRuntime, deliverCompletion, notificationOwner, notificationProject, parseSavedGenerations, sameCompletionResult, trackState, type Completion, type NotificationSession } from '../src/lib/completionTracker';

const job = (id: string, kind: Job['kind'] = 'image', status: Job['status'] = 'running'): Job => ({ id, project_id: 'project_1', kind, status, created_at: '2026-10-21T01:00:00Z', updated_at: '2026-10-21T01:00:00Z', url: 'https://local.invalid/media?sig=private' });
const state = (jobs: Job[] = [], patch: Partial<ProjectState> = {}): ProjectState => ({ stage: 'images', garments: [], directions: [], images: jobs.filter(item => item.kind === 'image').map(item => ({ id: `image_${item.id}`, shot_id: item.id, version: 1, status: item.status })), active_jobs: jobs, ...patch });
const example: Completion = { projectId: 'project_1', title: '春日合作', kind: 'image', jobIds: ['job_1'], body: '图片完成' };
const fixtureSession = (api: NotificationSession['api'], userId = 'user_1', baseUrl = 'http://local.invalid'): NotificationSession => ({ api, userId, baseUrl, token: `token-${userId}` });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('recent completions keep the latest five projects, with the newest incoming version first', () => {
  const previous = Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({ ...example, projectId: `p${5 - index}`, jobIds: [`old_${index}`] })));
  const incoming = Object.freeze([
    Object.freeze({ ...example, projectId: 'p6', jobIds: ['first'] }),
    Object.freeze({ ...example, projectId: 'p7', jobIds: ['second'] }),
    Object.freeze({ ...example, projectId: 'p6', kind: 'video' as const, jobIds: ['latest'] }),
  ]);
  const recent = appendRecentCompletions(previous, incoming);
  assert.deepEqual(recent.map(completion => completion.projectId), ['p6', 'p7', 'p5', 'p4', 'p3']);
  assert.deepEqual(recent[0].jobIds, ['latest']);
  assert.equal(recent[0].kind, 'video');
  assert.equal(previous.length, 5);
  assert.deepEqual(incoming.map(completion => completion.projectId), ['p6', 'p7', 'p6']);
});

test('replayed completion results retain read state while new jobs or kinds become unread', () => {
  const previous = [{ ...example, jobIds: ['one', 'two'], read: true }];
  const replay = { ...example, jobIds: ['two', 'one'], body: '重试后的文案' };
  assert.equal(sameCompletionResult(previous[0], replay), true);
  assert.equal(appendRecentCompletions(previous, [replay])[0].read, true);
  assert.equal(appendRecentCompletions(previous, [{ ...replay, jobIds: ['new'] }])[0].read, undefined);
  assert.equal(appendRecentCompletions(previous, [{ ...replay, kind: 'video' }])[0].read, undefined);
  assert.equal(sameCompletionResult(previous[0], { ...replay, projectId: 'another' }), false);
});

test('saved generations accept older progress and validate optional recent completion records', () => {
  const saved = { owner: 'owner', baseUrl: 'http://local.invalid', projects: [] };
  assert.equal(parseSavedGenerations(JSON.stringify(saved))?.recent, undefined);
  assert.deepEqual(parseSavedGenerations(JSON.stringify({ ...saved, recent: [example] }))?.recent, [example]);
  for (const recent of [null, {}, 'bad', [null], [{}], [{ ...example, projectId: 7 }], [{ ...example, title: null }], [{ ...example, kind: 'preview' }], [{ ...example, jobIds: 'job' }], [{ ...example, jobIds: [7] }], [{ ...example, body: null }], [{ ...example, read: 'yes' }], [{ ...example, read: null }]]) {
    assert.equal(parseSavedGenerations(JSON.stringify({ ...saved, recent })), undefined);
  }
  const restored = parseSavedGenerations(JSON.stringify({ ...saved, recent: [{ ...example, url: 'private-signed-address' }, example] }));
  assert.deepEqual(restored?.recent, [example]);
  assert.ok(!JSON.stringify(restored).includes('private-signed-address'));
  assert.deepEqual(parseSavedGenerations(JSON.stringify({ ...saved, recent: [{ ...example, read: true }] }))?.recent, [{ ...example, read: true }]);
  assert.deepEqual(parseSavedGenerations(JSON.stringify({ ...saved, recent: [{ ...example, read: false }] }))?.recent, [example]);
});

test('marking a completion read persists once and survives a runtime restart without notifying again', async () => {
  const session = fixtureSession({ state: async () => state(), job: async id => job(id, 'image', 'succeeded') });
  let stored: string | null = JSON.stringify({ owner: notificationOwner(session), baseUrl: session.baseUrl, projects: [], recent: [example] });
  let saves = 0, deliveries = 0;
  const feeds: (readonly Completion[])[] = [];
  const dependencies = {
    load: async () => stored,
    save: async (value: string | null) => { stored = value; saves++; },
    deliver: async () => { deliveries++; },
    onCompletions: (_scope: string, values: readonly Completion[]) => { feeds.push(values); },
  };
  const runtime = createGenerationRuntime(dependencies);
  await runtime.configure(session);
  await runtime.markRead(example.projectId, example.jobIds);
  assert.deepEqual(parseSavedGenerations(stored)?.recent, [{ ...example, read: true }]);
  assert.equal(feeds.at(-1)?.[0].read, true);
  const savedCount = saves, publishedCount = feeds.length;
  await runtime.markRead(example.projectId, example.jobIds);
  await runtime.markRead('missing');
  assert.equal(saves, savedCount);
  assert.equal(feeds.length, publishedCount);
  const restored = createGenerationRuntime(dependencies);
  await restored.configure(session);
  await restored.poll();
  assert.equal(feeds.at(-1)?.[0].read, true);
  assert.equal(deliveries, 0);
});

test('a failed read-state save can be retried and publishes only after persistence succeeds', async () => {
  const session = fixtureSession({ state: async () => state(), job: async id => job(id, 'image', 'succeeded') });
  let stored: string | null = JSON.stringify({ owner: notificationOwner(session), baseUrl: session.baseUrl, projects: [], recent: [example] });
  let failNextSave = false;
  const feeds: (readonly Completion[])[] = [];
  const runtime = createGenerationRuntime({
    load: async () => stored,
    save: async value => { if (failNextSave) { failNextSave = false; throw new Error('storage unavailable'); } stored = value; },
    deliver: async () => undefined,
    onCompletions: (_scope, values) => { feeds.push(values); },
  });
  await runtime.configure(session);
  const publications = feeds.length;
  failNextSave = true;
  await assert.rejects(runtime.markRead(example.projectId, example.jobIds), /storage unavailable/);
  assert.equal(parseSavedGenerations(stored)?.recent?.[0].read, undefined);
  assert.equal(feeds.length, publications);
  await runtime.markRead(example.projectId, example.jobIds);
  assert.equal(parseSavedGenerations(stored)?.recent?.[0].read, true);
  assert.equal(feeds.at(-1)?.[0].read, true);
  assert.equal(feeds.length, publications + 1);
});

test('a new result becomes unread and a stale click cannot mark its replacement read', async () => {
  const session = fixtureSession({ state: async () => state(), job: async id => job(id, 'image', 'succeeded') });
  let stored: string | null = JSON.stringify({ owner: notificationOwner(session), baseUrl: session.baseUrl, projects: [], recent: [{ ...example, read: true }] });
  let saves = 0;
  const feeds: (readonly Completion[])[] = [];
  const runtime = createGenerationRuntime({ load: async () => stored, save: async value => { stored = value; saves++; }, deliver: async () => undefined, onCompletions: (_scope, values) => { feeds.push(values); } });
  await runtime.configure(session);
  await runtime.observe(example.projectId, example.title, state([job('new-result')]));
  await runtime.poll();
  assert.deepEqual(feeds.at(-1)?.[0].jobIds, ['new-result']);
  assert.equal(feeds.at(-1)?.[0].read, undefined);
  const savedCount = saves, publishedCount = feeds.length;
  await runtime.markRead(example.projectId, example.jobIds);
  assert.equal(saves, savedCount);
  assert.equal(feeds.length, publishedCount);
  assert.equal(parseSavedGenerations(stored)?.recent?.[0].read, undefined);
  await runtime.markRead(example.projectId);
  assert.equal(parseSavedGenerations(stored)?.recent?.[0].read, true);
});

test('queued read updates cannot cross an account change', async () => {
  const api: NotificationSession['api'] = { state: async () => state(), job: async id => job(id, 'image', 'succeeded') };
  const alice = fixtureSession(api, 'alice'), bob = fixtureSession(api, 'bob');
  const loading = deferred<string | null>();
  const entered = deferred<void>();
  let stored: string | null = JSON.stringify({ owner: notificationOwner(bob), baseUrl: bob.baseUrl, projects: [], recent: [example] });
  let loads = 0;
  const feeds: { scope: string; values: readonly Completion[] }[] = [];
  const runtime = createGenerationRuntime({
    load: async () => { if (++loads === 1) { entered.resolve(); return loading.promise; } return stored; },
    save: async value => { stored = value; }, deliver: async () => undefined,
    onCompletions: (scope, values) => { feeds.push({ scope, values }); },
  });
  const initial = runtime.configure(alice);
  await entered.promise;
  const pendingRead = runtime.markRead(example.projectId, example.jobIds);
  const switched = runtime.configure(bob);
  loading.resolve(null);
  await Promise.all([initial, pendingRead, switched]);
  assert.equal(parseSavedGenerations(stored)?.owner, notificationOwner(bob));
  assert.deepEqual(parseSavedGenerations(stored)?.recent, [example]);
  assert.deepEqual(feeds, [{ scope: notificationOwner(bob), values: [example] }]);
  await runtime.configure(null);
  await runtime.markRead(example.projectId);
  assert.equal(stored, null);
});

test('cold-start recent completion restoration populates its owner feed without repeating any delivery', async () => {
  let deliveries = 0;
  let reads = 0;
  const feeds: { scope: string; values: readonly Completion[] }[] = [];
  const session = fixtureSession({ state: async () => { reads++; return state(); }, job: async () => job('job_1', 'image', 'succeeded') });
  let stored: string | null = JSON.stringify({ owner: notificationOwner(session), baseUrl: session.baseUrl, projects: [{ id: 'project_1', title: example.title, jobs: [job('job_1', 'image', 'succeeded')], announced: ['job_1'] }], recent: [example] });
  const runtime = createGenerationRuntime({
    load: async () => stored,
    save: async value => { stored = value; },
    deliver: async () => { deliveries++; },
    onCompletions: (scope, values) => { feeds.push({ scope, values }); },
  });
  await runtime.configure(session);
  await runtime.poll();
  assert.deepEqual(feeds, [{ scope: notificationOwner(session), values: [example] }]);
  assert.equal(deliveries, 0);
  assert.equal(reads, 0);
  assert.deepEqual(parseSavedGenerations(stored)?.recent, [example]);
});

test('background completions persist and publish to the feed even when notification permission is denied', async () => {
  let stored: string | null = null;
  let complete = false;
  let notices = 0;
  const feeds: (readonly Completion[])[] = [];
  const session = fixtureSession({ state: async () => state(complete ? [] : [job('first')]), job: async () => job('first', 'image', complete ? 'succeeded' : 'running') });
  const runtime = createGenerationRuntime({
    load: async () => stored,
    save: async value => { stored = value; },
    onCompletions: (scope, values) => { assert.equal(scope, notificationOwner(session)); feeds.push(values); },
    deliver: (completion, owner, isCurrent, listener) => deliverCompletion(completion, owner, {
      isForeground: () => false, isCurrent, permissionGranted: async () => false,
      foreground: value => { notices++; listener?.(value); }, schedule: async () => { notices++; },
    }),
  });
  await runtime.configure(session);
  await runtime.observe('project_1', '后台出好的一组片', state([job('first')]));
  complete = true;
  await runtime.poll();
  assert.equal(notices, 0);
  assert.equal(feeds.at(-1)?.length, 1);
  assert.equal(feeds.at(-1)?.[0].title, '后台出好的一组片');
  assert.deepEqual(parseSavedGenerations(stored)?.recent, feeds.at(-1));
  assert.deepEqual(parseSavedGenerations(stored)?.projects[0].announced, ['first']);
  const publications = feeds.length;
  await runtime.poll();
  assert.equal(feeds.length, publications);
});

test('tracker excludes preview jobs across stage changes and strips signed media from persisted progress', () => {
  const preview = job('preview');
  let watched = trackState(undefined, 'project_1', '春日合作', state([preview], { stage: 'direction', images: [] }));
  assert.deepEqual(watched.jobs, []);
  watched = trackState(watched, 'project_1', '这组片', state([preview], { stage: 'script', images: [] }));
  assert.equal(watched.title, '春日合作');
  const image = { ...job('shot'), created_at: '2026-10-21T01:01:00Z' };
  watched = trackState(watched, 'project_1', '这组片', state([preview, image], { images: [{ id: 'image', shot_id: 'shot', status: 'running', version: 1 }] }));
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
  const feeds: (readonly Completion[])[] = [];
  const api = {
    state: async () => { requests += 1; if (deleted) throw Object.assign(new Error('deleted'), { status: 404 }); return state(complete ? [] : [job('first')]); },
    job: async () => job('first', 'image', complete ? 'succeeded' : 'running'),
  };
  const dependencies = {
    load: async () => stored,
    save: async (value: string | null) => { stored = value; },
    onCompletions: (_scope: string, values: readonly Completion[]) => { feeds.push(values); },
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
  assert.equal(parseSavedGenerations(stored)?.recent?.length, 1, 'failed delivery does not remove the completion feed');
  assert.deepEqual(feeds.at(-1), parseSavedGenerations(stored)?.recent);
  await restored.poll();
  assert.equal(delivered.length, 1);
  await restored.poll();
  assert.equal(delivered.length, 1);
  const afterRestart = createGenerationRuntime(dependencies);
  await afterRestart.configure(fixtureSession(api));
  await afterRestart.poll();
  assert.equal(delivered.length, 1);
  assert.equal(feeds.at(-1)?.length, 1, 'cold-start restoration publishes the feed without redelivering');
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

test('auto remains watched while no jobs exist between directions, images and video, then announces once', async () => {
  const auto = { active: true, step: 'directions' as const, label: '找方向', started_at: '2026-10-21T01:00:00Z', estimate_points: 48 };
  let fresh = state([], { mode: 'auto', stage: 'direction', auto });
  let reads = 0;
  const deliveries: Completion[] = [];
  const runtime = createGenerationRuntime({ deliver: async completion => { deliveries.push(completion); } });
  await runtime.configure(fixtureSession({ state: async () => { reads++; return fresh; }, job: async id => job(id, 'video', 'succeeded') }));
  await runtime.observe('project_1', '一键出片', fresh);
  await runtime.poll();
  assert.equal(reads, 1, 'leaving while finding directions must keep checking state');
  fresh = state([], { mode: 'auto', stage: 'note', auto: { ...auto, step: 'note' } });
  await runtime.poll();
  assert.equal(reads, 2, 'a gap before video is queued must not stop watching');
  fresh = state([], { mode: 'auto', stage: 'done', auto: { ...auto, active: false, step: 'done' }, video: { status: 'succeeded', job_id: 'auto_video' } });
  await runtime.poll();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, 'video');
  await runtime.poll();
  assert.equal(reads, 3);
  assert.equal(deliveries.length, 1);
});
