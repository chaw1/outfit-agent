import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeLiveBase, performLiveOnce, sanitizeLiveEvidence, saveLiveCheckpoint, selectLiveRun } from '../e2e/live-support';

test('live retries preserve the same account, paid-action markers and project', () => {
  const first = selectLiveRun(undefined, 'https://personal.example', false);
  first.projectId = 'project-1';
  first.sent.confirm_script = '2026-10-20T16:30:00Z';
  first.completed.push('register');
  const resumed = selectLiveRun(first, first.base, false);
  assert.equal(resumed, first);
  assert.equal(resumed.projectId, 'project-1');
  assert.deepEqual(resumed.sent, first.sent);
  assert.match(first.username, /^live-/);
  assert.ok(first.username.length <= 32);
});

test('live fresh runs are explicit and the fourth project is rejected', () => {
  const first = selectLiveRun(undefined, 'https://personal.example', false);
  const second = selectLiveRun(first, first.base, true);
  const third = selectLiveRun(second, first.base, true);
  assert.deepEqual([first.run, second.run, third.run], [1, 2, 3]);
  assert.deepEqual(third.completed, []);
  assert.deepEqual(third.sent, {});
  assert.throws(() => selectLiveRun(third, first.base, true), /3/);
  assert.equal(selectLiveRun(third, first.base, false), third);
  assert.throws(() => selectLiveRun(first, 'https://another.example', false), /其他服务/);
});

test('live endpoint rejects embedded credentials and evidence strips nested secrets', () => {
  assert.equal(normalizeLiveBase('https://personal.example///'), 'https://personal.example');
  assert.equal(normalizeLiveBase('https://personal.example/api/'), 'https://personal.example');
  for (const value of ['ftp://personal.example', 'https://user:secret@personal.example', 'https://personal.example?token=secret', 'https://personal.example#secret']) {
    assert.throws(() => normalizeLiveBase(value));
  }
  const source = {
    Authorization: 'Bearer secret-header', token: 'secret-token', password: 'secret-password',
    nested: [{ cookie: 'secret-cookie', url: 'https://personal.example/media/a?exp=999&sig=secret-signature&size=390' }],
    text: 'GET https://personal.example/media/a?sig=secret-signature Bearer secret-inline',
  };
  const evidence = sanitizeLiveEvidence(source);
  assert.equal(JSON.stringify(evidence).includes('secret-'), false);
  assert.equal(source.token, 'secret-token');
  assert.match(JSON.stringify(evidence), /size=390/);
});

test('a failed UI preparation clears the unsent marker and resumes in the same project', async () => {
  const checkpoint = selectLiveRun(undefined, 'https://personal.example', false);
  checkpoint.projectId = 'same-project';
  let stops = 0;
  const snapshots: Record<string, string>[] = [];
  const persist = async () => { snapshots.push({ ...checkpoint.sent }); };
  await assert.rejects(performLiveOnce(checkpoint, 'confirm-script', persist, async () => {
    throw new Error('button not yet enabled');
  }, () => () => { stops += 1; }), /button not yet enabled/);
  assert.deepEqual(checkpoint.sent, {});
  assert.ok(snapshots[0]?.['confirm-script']);
  assert.deepEqual(snapshots[1], {});
  let observe: () => void = () => {};
  await performLiveOnce(checkpoint, 'confirm-script', persist, async () => { observe(); }, callback => {
    observe = callback; return () => { stops += 1; };
  });
  assert.equal(checkpoint.projectId, 'same-project');
  assert.ok(checkpoint.sent['confirm-script']);
  assert.equal(stops, 2);
});

test('a failure after the actual request retains the marker and never repeats the paid send', async () => {
  const checkpoint = selectLiveRun(undefined, 'https://personal.example', false);
  let observed: () => void = () => {};
  let calls = 0;
  let persistedBeforeSend = false;
  const persist = async () => { persistedBeforeSend = Boolean(checkpoint.sent['brush-edit']); };
  const work = async () => {
    calls += 1;
    assert.equal(persistedBeforeSend, true);
    observed();
    throw new Error('response interrupted');
  };
  const observe = (callback: () => void) => { observed = callback; return () => {}; };
  await assert.rejects(performLiveOnce(checkpoint, 'brush-edit', persist, work, observe), /response interrupted/);
  assert.ok(checkpoint.sent['brush-edit']);
  await performLiveOnce(checkpoint, 'brush-edit', persist, work, observe);
  assert.equal(calls, 1);
});

test('private run archives preserve credentials and paid-action progress when the latest run advances', async t => {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'live-checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'checkpoint.json');
  const first = selectLiveRun(undefined, 'https://personal.example', false);
  first.projectId = 'first-project'; first.session = 'first-session';
  await saveLiveCheckpoint(first, destination);
  first.sent['confirm-script'] = '2026-10-20T16:30:00Z';
  first.completed.push('06-confirm-script'); first.data.editParentId = 'first-image';
  await saveLiveCheckpoint(first, destination);
  const second = selectLiveRun(first, first.base, true);
  second.projectId = 'second-project'; second.session = 'second-session';
  // An interrupted save may leave a permissive temporary file; final credentials stay private.
  await writeFile(`${destination}.tmp`, 'interrupted', { mode: 0o644 });
  await writeFile(path.join(directory, 'private', 'run-2.json.tmp'), 'interrupted', { mode: 0o644 });
  await saveLiveCheckpoint(second, destination);
  const archive = (run: number) => path.join(directory, 'private', `run-${run}.json`);
  assert.deepEqual(JSON.parse(await readFile(archive(1), 'utf8')), first);
  assert.deepEqual(JSON.parse(await readFile(archive(2), 'utf8')), second);
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), second);
  for (const file of [destination, archive(1), archive(2)]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, 'private'))).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(path.join(directory, 'private'))).sort(), ['run-1.json', 'run-2.json']);
});

test('advancing a legacy latest checkpoint archives the previous run before replacing it', async t => {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'live-checkpoint-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'checkpoint.json');
  const first = selectLiveRun(undefined, 'https://personal.example', false);
  first.projectId = 'legacy-project'; first.session = 'legacy-session'; first.sent['brush-edit'] = '2026-10-20T16:45:00Z';
  await writeFile(destination, JSON.stringify(first), { mode: 0o600 });
  await saveLiveCheckpoint(selectLiveRun(first, first.base, true), destination);
  const archived = path.join(directory, 'private', 'run-1.json');
  assert.deepEqual(JSON.parse(await readFile(archived, 'utf8')), first);
  assert.equal((await stat(archived)).mode & 0o777, 0o600);
});
