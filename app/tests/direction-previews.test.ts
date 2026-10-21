import assert from 'node:assert/strict';
import test from 'node:test';
import type { Direction } from '../src/api/types';
import { chooseDirectionPreview, directionPreviews, retryDirectionPreview, selectedPreview } from '../src/lib/directionPreviews';

const direction: Direction = { id: 'city', name: '城市漫步', scene: '街角', mood: '松弛', palette: '奶白', why: '自然', sample_title: '周末', previews: [
  { id: 'full', status: 'succeeded', url: '/full.jpg', variant: '全身街拍' },
  { id: 'close', status: 'running', variant: '半身特写' },
  { id: 'seated', status: 'failed', variant: '坐姿侧光' },
] };

test('selection defaults to the first image, retains the chosen variant and recovers from stale IDs', () => {
  assert.equal(selectedPreview(direction).id, 'full');
  assert.equal(selectedPreview(direction, 'seated').variant, '坐姿侧光');
  assert.equal(selectedPreview(direction, 'old-group').id, 'full');
  assert.deepEqual(chooseDirectionPreview(direction), { type: 'choose_direction', direction_id: 'city', preview_id: 'full' });
  assert.equal(chooseDirectionPreview(direction, 'seated').preview_id, 'seated');
});

test('legacy cards remain selectable without sending a synthetic preview ID', () => {
  const legacy = { ...direction, previews: undefined, preview_url: '/legacy.jpg', preview_status: 'succeeded' as const };
  assert.equal(directionPreviews(legacy)[0].url, legacy.preview_url);
  assert.deepEqual(chooseDirectionPreview(legacy), { type: 'choose_direction', direction_id: 'city' });
});

test('retry addresses only the failed image; stable replay and new attempts have distinct keys', () => {
  assert.equal(retryDirectionPreview(direction, 'full'), undefined);
  assert.equal(retryDirectionPreview(direction, 'close'), undefined);
  assert.equal(retryDirectionPreview(direction, 'unknown'), undefined);
  const action = retryDirectionPreview(direction, 'seated', 'attempt-1')!;
  assert.deepEqual(action, { type: 'retry_preview', direction_id: 'city', preview_id: 'seated', attempt: 'attempt-1' });
  assert.equal(action.attempt, 'attempt-1');
  assert.deepEqual(retryDirectionPreview(direction, 'seated', 'attempt-1'), action);
  assert.notEqual(retryDirectionPreview(direction, 'seated')!.attempt, retryDirectionPreview(direction, 'seated')!.attempt);
  const another = { ...direction, id: 'another-direction' };
  assert.notDeepEqual(retryDirectionPreview(another, 'seated', 'attempt-1'), action);
});
