import assert from 'node:assert/strict';
import test from 'node:test';
import { AMPLE_POINTS, remainingLabel } from '../src/lib/transparency';

test('normal quotas show the remaining points', () => {
  assert.equal(remainingLabel(180.4), '今日还有 180.4 点');
});

test('effectively unlimited quotas are shown as ample instead of a long number', () => {
  assert.equal(remainingLabel(AMPLE_POINTS), '今日额度充足');
  assert.equal(remainingLabel(999980.4), '今日额度充足');
});
