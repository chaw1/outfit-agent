import assert from 'node:assert/strict';
import test from 'node:test';
import { cardsFromState, mergeCards, mergeImages, mergeJobs, mergeProjectState, mergeStateIntoCards } from '../src/api/merge';
import type { Card, Job, JobStatus, ProjectState } from '../src/api/types';

function job(status: JobStatus, updated = '2026-10-20T02:00:00Z'): Job {
  return { id: 'j1', project_id: 'p1', kind: 'image', status, created_at: '2026-10-20T01:00:00Z', updated_at: updated };
}

function state(overrides: Partial<ProjectState> = {}): ProjectState {
  return { stage: 'brief', garments: [], directions: [], images: [], active_jobs: [], ...overrides };
}

test('same-id cards are replaced completely, preserve order, and never mutate inputs', () => {
  const first: Card = { id: 'same', type: 'video', status: 'running', job_id: 'old' };
  const other: Card = { id: 'other', type: 'images', items: [] };
  const updated: Card = { id: 'same', type: 'video', status: 'succeeded', url: '/video.mp4' };
  const previous = Object.freeze([Object.freeze(first), other]);
  const result = mergeCards(previous, [updated, { id: 'new', type: 'garments', items: [] }]);
  assert.deepEqual(result.map((card) => card.id), ['same', 'other', 'new']);
  assert.deepEqual(result[0], updated);
  assert.equal('job_id' in (result[0] ?? {}), false);
  assert.equal(first.status, 'running');
});

test('jobs progress queued → running → terminal, reject stale and contradictory terminal events', () => {
  let jobs = mergeJobs([], [job('queued')]);
  jobs = mergeJobs(jobs, [job('running')]);
  assert.equal(jobs[0]?.status, 'running');
  jobs = mergeJobs(jobs, [job('queued', '2026-10-20T03:00:00Z')]);
  assert.equal(jobs[0]?.status, 'running');
  jobs = mergeJobs(jobs, [{ ...job('succeeded', '2026-10-20T03:00:00Z'), url: '/result.jpg' }]);
  jobs = mergeJobs(jobs, [job('running'), job('failed', '2026-10-20T04:00:00Z')]);
  assert.equal(jobs[0]?.status, 'succeeded');
  assert.equal(jobs[0]?.url, '/result.jpg');
  const failed = mergeJobs([job('failed')], [job('queued'), job('succeeded')]);
  assert.equal(failed[0]?.status, 'failed');
});

test('equal-status job updates use timestamps and can add result details', () => {
  const newer = { ...job('succeeded', '2026-10-20T04:00:00Z'), url: '/new.jpg' };
  assert.equal(mergeJobs([newer], [{ ...job('succeeded'), url: '/old.jpg' }])[0]?.url, '/new.jpg');
  assert.equal(mergeJobs([job('succeeded')], [newer])[0]?.url, '/new.jpg');
});

test('image versions are separate records and completed results do not regress', () => {
  const first = { id: 'i1', shot_id: 's1', status: 'succeeded' as const, version: 1, url: '/v1.jpg' };
  const images = mergeImages([first], [
    { ...first, status: 'queued' },
    { id: 'i2', shot_id: 's1', status: 'queued', version: 2, parent_id: 'i1', instruction: '更亮' },
  ]);
  assert.equal(images[0]?.status, 'succeeded');
  assert.equal(images[1]?.parent_id, 'i1');
});

test('state restores cards and polling refreshes an existing stable card id', () => {
  const snapshot = state({
    stage: 'note',
    images: [{ id: 'i1', shot_id: 's1', status: 'succeeded', version: 1, url: '/one.jpg' }],
    note: { title: '今天这样穿', body: '一身刚刚好', tags: ['穿搭'], image_ids: ['i1'] },
  });
  assert.deepEqual(cardsFromState(snapshot).map((card) => card.type), ['images', 'note']);
  const result = mergeStateIntoCards([{ id: 'backend-card-id', type: 'images', items: [] }], snapshot);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, 'backend-card-id');
  assert.equal(result[0]?.type === 'images' && result[0].items[0]?.url, '/one.jpg');
});

test('authoritative state clears old note/video and empty jobs while retaining image completion', () => {
  const previous = state({
    stage: 'images',
    active_jobs: [job('running')],
    images: [{ id: 'i1', shot_id: 's1', status: 'succeeded', version: 1, url: '/one.jpg' }],
    note: { title: '旧笔记', body: '旧正文', tags: [], image_ids: ['i1'] },
    video: { status: 'succeeded', url: '/old.mp4' },
  });
  const merged = mergeProjectState(previous, state({
    stage: 'script',
    images: [{ id: 'i1', shot_id: 's1', status: 'running', version: 1 }],
  }));
  assert.equal(merged.stage, 'script');
  assert.deepEqual(merged.active_jobs, []);
  assert.equal(merged.note, undefined);
  assert.equal(merged.video, undefined);
  assert.equal(merged.images[0]?.status, 'succeeded');
  assert.equal(merged.images[0]?.url, '/one.jpg');
  assert.equal(mergeProjectState(undefined, previous), previous);
});
