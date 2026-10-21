import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTO_STEPS, autoProgress } from '../src/lib/autoProgress';

test('自动出片六个步骤保持契约顺序并准确映射当前步骤', () => {
  assert.deepEqual(AUTO_STEPS.map(value => value.step), ['directions', 'script', 'images', 'note', 'video', 'done']);
  for (const [index, value] of AUTO_STEPS.entries()) {
    const progress = autoProgress({ active: value.step !== 'done', step: value.step, label: value.label, started_at: '2026-10-21', estimate_points: 48 });
    assert.equal(progress.index, index);
    assert.equal(progress.percent, index * 20);
    assert.equal(progress.steps.filter(step => step.completed).length, index === 5 ? 6 : index);
    assert.equal(progress.steps.filter(step => step.current).length, index === 5 ? 0 : 1);
  }
});
