import test from 'node:test';
import assert from 'node:assert/strict';
import type { NoteData, OutfitImage } from '../src/api/types';
import { approveImages, defaultImageIds, replaceShotVersion } from '../src/lib/imageSelection';

const image = (id: string, shot_id: string, version: number, extra: Partial<OutfitImage> = {}): OutfitImage => ({ id, shot_id, version, status: 'succeeded', url: `local/${id}`, ...extra });
const first = image('old', 'one', 1);
const failedCheck = image('unverified', 'one', 2, { edit_check: { passed: false, reason: '袖口仍卷起' } });

test('newest successful verified image wins per shot; unverified, failed and pending never replace it', () => {
  const images = [first, image('two', 'two', 1), failedCheck, image('pending', 'two', 5, { status: 'running' }), image('failed', 'one', 4, { status: 'failed' })];
  assert.deepEqual(defaultImageIds(images), ['old', 'two']);
  assert.deepEqual(defaultImageIds([...images, image('verified', 'one', 6, { edit_check: { passed: true, reason: '袖口已放下' } })]), ['verified', 'two']);
});

test('a shot with only unverified versions stays unselected and does not enter the order', () => {
  assert.deepEqual(defaultImageIds([failedCheck, image('two', 'two', 1)]), ['two']);
  assert.deepEqual(defaultImageIds([image('missing-url', 'one', 3, { url: undefined })]), []);
});

test('note selections retain explicitly accepted versions and order', () => {
  const two = image('two', 'two', 1);
  const note: NoteData = { title: '', body: '', tags: [], image_ids: ['two', failedCheck.id], accepted_unverified_ids: [failedCheck.id] };
  assert.deepEqual(defaultImageIds([first, failedCheck, two], note), ['two', failedCheck.id]);
});

test('adopting a version replaces only its shot and preserves the cover position', () => {
  const two = image('two', 'two', 1);
  assert.deepEqual(replaceShotVersion(['two', 'old'], failedCheck, [first, failedCheck, two]), ['two', 'unverified']);
  assert.deepEqual(replaceShotVersion(['old', 'two'], failedCheck, [first, failedCheck, two]), ['unverified', 'two']);
  assert.deepEqual(replaceShotVersion(['two'], failedCheck, [first, failedCheck, two]), ['two', 'unverified']);
});

test('approve_images only carries selected, unverified IDs explicitly accepted by the user', () => {
  assert.deepEqual(approveImages(['old', 'unverified'], [first, failedCheck], []), { type: 'approve_images', image_ids: ['old', 'unverified'] });
  assert.deepEqual(approveImages(['unverified'], [first, failedCheck], ['old', 'unverified', 'missing']), { type: 'approve_images', image_ids: ['unverified'], accept_unverified: ['unverified'] });
});

test('default draft skips low person scores and prefers a consistent repaired version', () => {
  const low = { id: 'low-face', shot_id: 'person-shot', status: 'succeeded' as const, version: 1, url: 'http://localhost/low', fidelity: { score: 95, person_score: 55, diffs: [], auto_fixed: false } };
  const high = { ...low, id: 'fixed-face', version: 2, fidelity: { ...low.fidelity, person_score: 92, auto_fixed: true } };
  assert.deepEqual(defaultImageIds([low]), []);
  assert.deepEqual(defaultImageIds([low, high]), ['fixed-face']);
});
