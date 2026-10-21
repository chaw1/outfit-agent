import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_SCENES, OUTPAINT_DIRECTIONS, quickToolAction } from '../src/lib/quickTools';
import { prepareEditSubmission } from '../src/lib/editAttempt';
import { traceSummary } from '../src/lib/transparency';

test('six backgrounds and custom scenes preserve subject, clothes, pose and lighting', () => {
  assert.deepEqual(BACKGROUND_SCENES, ['街角', '咖啡馆窗边', '白盒子展厅', '海边傍晚', '地铁站', '纯色影棚']);
  for (const scene of [...BACKGROUND_SCENES, '  夜晚的书店  ']) {
    const action = quickToolAction('original', 'background', scene);
    assert.equal(action.preset, 'background');
    assert.equal(action.background, scene.trim());
    assert.equal(action.instruction, `只换背景为 ${scene.trim()}，人物、服装、姿势、光线方向保持不变`);
  }
  assert.throws(() => quickToolAction('original', 'background', ' '));
});

test('direction controls map to distinct replayable outpaint parameters', () => {
  assert.deepEqual(OUTPAINT_DIRECTIONS.map(item => [item.label, item.value]), [['上', 'top'], ['下', 'bottom'], ['左右', 'horizontal'], ['四周', 'all']]);
  const keys = OUTPAINT_DIRECTIONS.map(({ value }) => {
    const action = quickToolAction('original', 'outpaint', '', value);
    assert.equal(action.direction, value);
    assert.equal(action.instruction, '补全画面边缘的场景，人物与服装不变');
    const submission = prepareEditSubmission(action);
    assert.equal(prepareEditSubmission(action, submission).action.attempt, submission.action.attempt);
    return submission.key;
  });
  assert.equal(new Set(keys).size, 4);
});

test('upscale carries its preset and process transparency uses the selected tool name', () => {
  const action = quickToolAction('original', 'upscale');
  assert.equal(action.preset, 'upscale');
  assert.equal(action.direction, undefined);
  for (const [tool, label] of [['background', '换背景'], ['outpaint', '扩图'], ['upscale', '高清']] as const) {
    assert.match(traceSummary({ tool, model: 'mock', cost_cny: 0, duration_ms: 10, refs: [], steps: [] }), new RegExp(label));
  }
});
