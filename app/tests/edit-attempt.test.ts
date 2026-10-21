import test from 'node:test';
import assert from 'node:assert/strict';
import type { Action } from '../src/api/types';
import { editWithAttempt, prepareEditSubmission, rejectedResult, reusedResult } from '../src/lib/editAttempt';

const action: Extract<Action, { type: 'edit_image' }> = { type: 'edit_image', image_id: 'original', instruction: '袖口放下来', region: { x: .1, y: .2, w: .3, h: .4 } };

test('one submission gets a UUID, and transport replay preserves that attempt and selection', () => {
  const first = prepareEditSubmission(action);
  assert.match(first.action.attempt!, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(prepareEditSubmission({ ...action }, first).action, first.action);
  assert.equal(editWithAttempt(first.action), first.action);
});

test('explicit retry and rephrasing use new attempts, retaining the same parent and selection', () => {
  const first = prepareEditSubmission(action);
  const retry = prepareEditSubmission(first.action, first, true);
  assert.notEqual(retry.action.attempt, first.action.attempt);
  assert.deepEqual({ ...retry.action, attempt: undefined }, { ...first.action, attempt: undefined });
  const rephrase = prepareEditSubmission({ ...action, instruction: '把卷起的袖口完全放下来' });
  assert.notEqual(rephrase.action.attempt, first.action.attempt);
  assert.deepEqual(rephrase.action.region, first.action.region);
  const changedRegion = prepareEditSubmission({ ...action, region: { x: .4, y: .2, w: .3, h: .4 } }, first);
  assert.notEqual(changedRegion.action.attempt, first.action.attempt);
});

test('legacy action callbacks stay compatible; reused responses stop waiting rather than count as rejection', () => {
  assert.equal(rejectedResult(false), true);
  assert.equal(rejectedResult({ accepted: false }), true);
  assert.equal(rejectedResult(undefined), false);
  assert.equal(reusedResult({ accepted: true, reused: true }), true);
  assert.equal(rejectedResult({ accepted: true, reused: true }), false);
  assert.equal(reusedResult({ accepted: true }), false);
});
