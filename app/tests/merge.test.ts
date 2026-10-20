import assert from 'node:assert/strict';
import test from 'node:test';
import { cardsFromState, mergeCards, mergeImages, mergeJobs, mergeProjectState, mergeStateIntoCards, stateWithCard } from '../src/api/merge';
import type { Card, Job, JobStatus, OutfitImage, ProjectState, ScriptData } from '../src/api/types';

function job(status: JobStatus, updated = '2026-10-20T02:00:00Z'): Job {
  return { id: 'j1', project_id: 'p1', kind: 'image', status, created_at: '2026-10-20T01:00:00Z', updated_at: updated };
}

function state(overrides: Partial<ProjectState> = {}): ProjectState {
  return { stage: 'brief', garments: [], directions: [], images: [], active_jobs: [], ...overrides };
}

test('reference cards persist through polling without changing the current stage or pending action', () => {
  const references: Card = { id: 'refs', type: 'references', items: [{ asset_id: 'r1', url: '/r1.jpg', style_tags: ['柔光'] }] };
  const snapshot = state({ stage: 'script', pending_action: { type: 'confirm_script', prompt: '确认' } });
  assert.strictEqual(stateWithCard(snapshot, references), snapshot);
  const cards = mergeStateIntoCards([references], snapshot);
  assert.deepEqual(cards.find(card => card.type === 'references'), references);
  const refreshed: Card = { ...references, items: [{ ...references.items[0], url: '/r1.jpg?fresh=1' }] };
  assert.deepEqual(mergeCards(cards, [refreshed]), [refreshed]);
});

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

test('local edit progress retains selection, check failures survive stale frames, and retry adds a distinct successful version', () => {
  const region = { x: 0, y: 0.423456789, w: 1, h: 0.1 };
  const original: OutfitImage = { id: 'original', shot_id: 'shot-1', status: 'succeeded', version: 1, url: '/original.jpg' };
  const queued: OutfitImage = { id: 'local-edit', shot_id: 'shot-1', status: 'queued', version: 2, parent_id: original.id, instruction: '袖口放下来', region };
  let images = mergeImages([original], [queued]);
  images = mergeImages(images, [{ id: queued.id, shot_id: queued.shot_id, version: queued.version, status: 'running' }]);
  assert.deepEqual(images[1]?.region, region);
  assert.equal(images[1]?.parent_id, original.id);
  const failedCheck: OutfitImage = { id: queued.id, shot_id: queued.shot_id, version: queued.version, status: 'succeeded', url: '/attempt.png', edit_check: { passed: false, reason: '袖口仍卷着。' } };
  images = mergeImages(images, [failedCheck]);
  images = mergeImages(images, [queued, { ...failedCheck, status: 'running', edit_check: undefined }]);
  const failedVersion = Object.freeze(images[1]!);
  assert.equal(failedVersion.status, 'succeeded');
  assert.deepEqual(failedVersion.region, region);
  assert.deepEqual(failedVersion.edit_check, failedCheck.edit_check);
  const retry: OutfitImage = { id: 'local-retry', shot_id: queued.shot_id, version: 3, parent_id: queued.id, instruction: queued.instruction, status: 'queued', region };
  images = mergeImages([original, failedVersion], [retry]);
  images = mergeImages(images, [{ ...retry, status: 'succeeded', url: '/retry.png', edit_check: { passed: true, reason: '袖口已放下。' } }]);
  assert.deepEqual(images.map(image => [image.id, image.parent_id, image.edit_check?.passed]), [[original.id, undefined, undefined], [queued.id, original.id, false], [retry.id, queued.id, true]]);
  assert.equal(failedVersion.edit_check?.passed, false);
  for (const stage of ['script', 'note', 'video', 'done'] as const) {
    const previous = state({ stage, images, ...(stage === 'script' ? { script: { status: 'draft' as const, title_ideas: [], cover: { scene: '', pose: '', text_overlay: '' }, shots: [], video: { prompt: '', duration: 5 } } } : {}), note: { title: '已选笔记', body: '正文', tags: [], image_ids: [original.id] }, video: { status: 'succeeded', url: '/video.mp4' } });
    const next = stateWithCard(previous, { id: 'progress', type: 'images', items: [queued] });
    assert.equal(next.stage, stage);
    assert.equal(next.note, previous.note);
    assert.equal(next.video, previous.video);
    assert.equal(next.images[1]?.edit_check?.passed, false);
    assert.deepEqual(next.images[2]?.region, region);
    const cards = mergeStateIntoCards([{ id: 'stable-card', type: 'images', items: [] }], next);
    const restored = cards.find(card => card.type === 'images');
    assert.equal(restored?.id, 'stable-card');
    assert.deepEqual(restored?.type === 'images' ? restored.items[1]?.edit_check : undefined, failedCheck.edit_check);
  }
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

const script: ScriptData = {
  status: 'draft', title_ideas: ['初版标题'], cover: { scene: '咖啡馆', pose: '侧身', text_overlay: '' },
  shots: [{ id: 's1', scene: '咖啡馆', outfit_asset_ids: [], pose: '侧身', camera: '全身', caption: '一杯咖啡' }],
  video: { prompt: '走向镜头', duration: 5 },
};

test('state cards carry previews, fidelity, script provenance, note cost and disclosure without mutating history', () => {
  const snapshot = state({
    stage: 'note', cost_cny: 3.25, last_message_id: 'm2',
    directions: [{ id: 'd1', name: '午后', scene: '咖啡馆', mood: '自然', palette: ['白'], why: '日常', sample_title: '午后出门', preview_status: 'succeeded', preview_url: '/preview.jpg' }],
    images: [{ id: 'i2', shot_id: 's1', status: 'succeeded', version: 2, parent_id: 'i1', url: '/fixed.jpg', instruction: '保留胸前口袋', script_version: 2, fidelity: { score: 92, diffs: ['恢复口袋'], auto_fixed: true } }],
    note: { title: '今天这样穿', body: '一身刚刚好', tags: [], image_ids: ['i2'], cost_cny: 3.25, ai_label: '含 AI 生成内容，发布时请勾选平台声明。' },
    script_versions: [{ version: 2, checkpoint_id: 'cp2', created_at: '2026-10-20T02:00:00Z', summary: '口袋和场景', current: true }],
  });
  const old: Card = { id: 'directions-card', type: 'directions', options: [] };
  const cards = mergeStateIntoCards([old], snapshot);
  const directions = cards.find(card => card.type === 'directions');
  const images = cards.find(card => card.type === 'images');
  const note = cards.find(card => card.type === 'note');
  assert.equal(directions?.id, old.id);
  assert.equal(directions?.type === 'directions' && directions.options[0]?.preview_url, '/preview.jpg');
  assert.equal(images?.type === 'images' && images.items[0]?.fidelity?.score, 92);
  assert.equal(images?.type === 'images' && images.items[0]?.script_version, 2);
  assert.equal(note?.type === 'note' && note.cost_cny, 3.25);
  assert.equal(note?.type === 'note' && note.ai_label, snapshot.note?.ai_label);
  assert.deepEqual(old.options, []);
  assert.deepEqual(mergeCards(cards, [{ ...snapshot.note!, id: note!.id, type: 'note', cost_cny: 4.5 }]).find(card => card.type === 'note'), { ...snapshot.note, id: note!.id, type: 'note', cost_cny: 4.5 });
});

test('a later images event extends note/video stages and retains their content and new project fields', () => {
  const note = { title: '笔记', body: '正文', tags: [], image_ids: ['i1'], cost_cny: 2.4, ai_label: 'AI生成' };
  for (const stage of ['note', 'video', 'done'] as const) {
    const previous = state({
      stage, note, video: { status: 'succeeded', url: '/one.mp4' }, cost_cny: 2.4, last_message_id: 'm1',
      images: [{ id: 'i1', shot_id: 's1', status: 'succeeded', version: 1, url: '/one.jpg' }],
    });
    const result = stateWithCard(previous, { id: 'images', type: 'images', items: [{ id: 'i2', shot_id: 's1', status: 'succeeded', version: 2, parent_id: 'i1', fidelity: { score: 93, diffs: [], auto_fixed: true } }] });
    assert.equal(result.stage, stage);
    assert.equal(result.note, note);
    assert.equal(result.video, previous.video);
    assert.equal(result.cost_cny, 2.4);
    assert.equal(result.last_message_id, 'm1');
    assert.deepEqual(result.images.map(image => image.id), ['i1', 'i2']);
  }
});

test('restoring a draft script and then receiving preserved images stays in script until confirmation', () => {
  const image = { id: 'i1', shot_id: 's1', status: 'succeeded' as const, version: 1, url: '/one.jpg', script_version: 2 };
  const previous = state({ stage: 'done', script: { ...script, status: 'confirmed' }, images: [image] });
  const restored = stateWithCard(previous, { ...script, id: 'script', type: 'script' });
  const afterImages = stateWithCard(restored, { id: 'images', type: 'images', items: [image] });
  assert.equal(afterImages.stage, 'script');
  assert.equal(afterImages.script?.status, 'draft');
  assert.deepEqual(afterImages.images, [image]);
  const confirmed = stateWithCard(afterImages, { ...script, id: 'script', type: 'script', status: 'confirmed' });
  assert.equal(stateWithCard(confirmed, { id: 'images', type: 'images', items: [image] }).stage, 'images');
});

test('restored authoritative history replaces current script metadata while keeping previously generated images', () => {
  const oldImage = { id: 'i1', shot_id: 's1', status: 'succeeded' as const, version: 1, url: '/one.jpg', script_version: 2 };
  const previous = state({ stage: 'note', script: { ...script, status: 'confirmed' }, images: [oldImage], script_versions: [{ version: 2, checkpoint_id: 'cp2', created_at: '2026-10-20T02:00:00Z', summary: '新版', current: true }] });
  const result = mergeProjectState(previous, state({ stage: 'script', script, script_versions: [{ version: 1, checkpoint_id: 'cp1', created_at: '2026-10-20T01:00:00Z', summary: '初版', current: true }, { ...previous.script_versions![0]!, current: false }], pending_action: { type: 'confirm_script', prompt: '确认恢复后的脚本' } }));
  assert.equal(result.stage, 'script');
  assert.equal(result.script?.title_ideas[0], '初版标题');
  assert.deepEqual(result.images, [oldImage]);
  assert.equal(result.script_versions?.find(version => version.current)?.checkpoint_id, 'cp1');
  assert.equal(result.pending_action?.type, 'confirm_script');
});
