import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '../src/api/types';
import { inProgressProjects, otherProjects } from '../src/lib/projectProgress';

const project = (id: string, updated: string, status?: NonNullable<Project['progress']>['status'], progressUpdated = updated): Project => ({
  id, title: id, brand: '自由创作', brief: '', stage: 'brief', created_at: updated, updated_at: updated,
  ...(status ? { progress: { status, label: status, running: 0, total: 0, updated_at: progressUpdated } } : {}),
});

test('ongoing projects include generating, waiting and ready states sorted by progress recency', () => {
  const projects = [
    project('old', '2026-10-20T01:00:00Z', 'generating'),
    project('legacy', '2026-10-21T10:00:00Z'),
    project('waiting', '2026-10-20T01:00:00Z', 'waiting_you', '2026-10-21T11:00:00Z'),
    project('ready', '2026-10-21T09:00:00Z', 'ready'),
    project('failed', '2026-10-21T12:00:00Z', 'failed'),
  ];
  assert.deepEqual(inProgressProjects(projects).map(item => item.id), ['waiting', 'ready', 'old']);
  assert.deepEqual(projects.map(item => item.id), ['old', 'legacy', 'waiting', 'ready', 'failed'], 'sorting must preserve the fetched list');
});

test('my studio preserves completed, failed, idle and older server projects without duplicating ongoing work', () => {
  const projects = [
    project('idle', '2026-10-21T05:00:00Z', 'idle'),
    project('generating', '2026-10-21T12:00:00Z', 'generating'),
    project('done', '2026-10-21T08:00:00Z', 'done'),
    project('legacy', '2026-10-21T10:00:00Z'),
    project('failed', '2026-10-21T06:00:00Z', 'failed'),
  ];
  assert.deepEqual(otherProjects(projects).map(item => item.id), ['legacy', 'done', 'failed', 'idle']);
  assert.equal(inProgressProjects(projects).length + otherProjects(projects).length, projects.length);
  assert.deepEqual(inProgressProjects([]), []);
});

test('pinning precedes recency in each existing section without mutating or mixing the sections', () => {
  const projects = [
    project('recent-active', '2026-10-21T12:00:00Z', 'generating'),
    { ...project('old-active-pin', '2026-10-20T01:00:00Z', 'ready'), pinned: true },
    { ...project('new-active-pin', '2026-10-21T10:00:00Z', 'waiting_you'), pinned: true },
    project('recent-other', '2026-10-21T12:00:00Z', 'done'),
    { ...project('old-other-pin', '2026-10-20T01:00:00Z', 'idle'), pinned: true },
    { ...project('new-other-pin', '2026-10-21T10:00:00Z', 'done'), pinned: true },
    project('old-other', '2026-10-19T01:00:00Z', 'idle'),
  ];
  const originalIds = projects.map(item => item.id);
  assert.deepEqual(inProgressProjects(projects).map(item => item.id), ['new-active-pin', 'old-active-pin', 'recent-active']);
  assert.deepEqual(otherProjects(projects).map(item => item.id), ['new-other-pin', 'old-other-pin', 'recent-other', 'old-other']);
  assert.deepEqual(projects.map(item => item.id), originalIds);
  assert.deepEqual(otherProjects(projects.map(item => ({ ...item, pinned: false }))).map(item => item.id), ['recent-other', 'new-other-pin', 'old-other-pin', 'old-other']);
});
