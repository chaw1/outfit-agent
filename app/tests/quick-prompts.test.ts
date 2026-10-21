import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickPrompts } from '../src/lib/quickPrompts';

const base = { mode: 'guided', video: null, active_jobs: [] } as const;

test('每个可对话阶段都有两到三句快捷话术，一键出片与生成中不显示', () => {
  for (const stage of ['brief', 'direction', 'script', 'images', 'note', 'done']) {
    const prompts = quickPrompts({ ...base, stage, video: stage === 'done' ? { status: 'succeeded' } : null } as never);
    assert.ok(prompts.length >= 2 && prompts.length <= 3, stage);
    assert.ok(prompts.every(item => item.length <= 14), stage);
  }
  assert.deepEqual(quickPrompts(undefined), []);
  assert.deepEqual(quickPrompts({ ...base, stage: 'note', mode: 'auto' } as never), []);
  assert.deepEqual(quickPrompts({ ...base, stage: 'note', active_jobs: [{ id: 'j' }] } as never), []);
  assert.deepEqual(quickPrompts({ ...base, stage: 'video' } as never), []);
});

test('做完短片后才提供“再做一条短片”', () => {
  assert.ok(!quickPrompts({ ...base, stage: 'done' } as never).includes('再做一条短片'));
  assert.ok(quickPrompts({ ...base, stage: 'done', video: { status: 'succeeded' } } as never).includes('再做一条短片'));
});
