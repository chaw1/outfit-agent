import assert from 'node:assert/strict';
import test from 'node:test';
import { canRephrase, persistedRetry, type FailedMessage } from '../src/lib/conversation';
import { emptyProjectState } from '../src/api/merge';
import type { Message } from '../src/api/types';
const reply: Message = { id: 'a', role: 'assistant', text: 'hello', cards: [], can_regenerate: true, created_at: '2026-10-20T01:00:00Z' };
test('rephrase requires explicit cost-safe server capability and only the last idle reply', () => {
  const state = emptyProjectState();
  assert.equal(canRephrase(reply, [reply], state), true);
  assert.equal(canRephrase({ ...reply, can_regenerate: undefined }, [reply], state), false);
  assert.equal(canRephrase({ ...reply, role: 'user' }, [reply], state), false);
  assert.equal(canRephrase(reply, [reply, { ...reply, id: 'new' }], state), false);
  state.active_jobs = [{ id: 'j', project_id: 'p', kind: 'image', status: 'running', created_at: '', updated_at: '' }];
  assert.equal(canRephrase(reply, [reply], state), false);
});
test('retry reconciles the new persisted user input and references before resending', () => {
  const failed: FailedMessage = { id: 'f', input: { text: 'same', refs: ['image'] }, text: 'same', certain: true, createdAt: '', baseline: ['old'] };
  const user: Message = { ...reply, id: 'new', role: 'user', text: 'same', refs: ['image'] };
  assert.equal(persistedRetry(failed, [user]), true);
  assert.equal(persistedRetry(failed, [{ ...user, id: 'old' }]), false);
  assert.equal(persistedRetry(failed, [{ ...user, refs: ['other'] }]), false);
  assert.equal(persistedRetry(failed, [{ ...user, text: 'different' }]), false);
});

test('retry reconciles accepted actions regardless of object key order, without replaying prior confirmations', () => {
  const failed: FailedMessage = { id: 'f', input: { action: { type: 'choose_direction', direction_id: 'd' } }, text: '就选这个方向', certain: true, createdAt: '', baseline: ['old'] };
  const user: Message = { ...reply, id: 'new', role: 'user', text: '', action: { direction_id: 'd', type: 'choose_direction' } };
  assert.equal(persistedRetry(failed, [user]), true);
  assert.equal(persistedRetry(failed, [{ ...user, id: 'old' }]), false);
  assert.equal(persistedRetry(failed, [{ ...user, action: { type: 'choose_direction', direction_id: 'other' } }]), false);
});
