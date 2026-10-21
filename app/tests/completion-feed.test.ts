import assert from 'node:assert/strict';
import test from 'node:test';
import { publishCompletion, recentCompletions, setRecentCompletions, subscribeCompletions } from '../src/lib/completionFeed';
import type { Completion } from '../src/lib/completionTracker';

const completion = (projectId: string): Completion => ({ projectId, title: '这组片', kind: 'video', jobIds: [`job-${projectId}`], body: '视频已出好' });
test('recent completion snapshots are stable, account scoped and refreshed once per project', () => {
  const first = 'local-account-one', second = 'local-account-two';
  assert.equal(recentCompletions(first), recentCompletions(first), 'empty snapshots must not trigger a render loop');
  let changes = 0;
  const stop = subscribeCompletions(first, () => { changes++; });
  publishCompletion(second, completion('private'));
  assert.equal(changes, 0);
  assert.deepEqual(recentCompletions(first), []);
  publishCompletion(first, completion('one'));
  const snapshot = recentCompletions(first);
  assert.equal(snapshot, recentCompletions(first));
  publishCompletion(first, { ...completion('one'), body: '新版已出好' });
  assert.equal(recentCompletions(first).length, 1);
  assert.equal(recentCompletions(first)[0].body, '新版已出好');
  assert.equal(changes, 2);
  stop();
  for (let index = 0; index < 8; index++) publishCompletion(first, completion(`next-${index}`));
  assert.equal(changes, 2);
  assert.equal(recentCompletions(first).length, 5);
  assert.equal(recentCompletions(first)[0].projectId, 'next-7');
  assert.equal(recentCompletions(second)[0].projectId, 'private');
});


test('persisted recent completions restore a stable snapshot without crossing account scopes', () => {
  const scope = 'restored-account';
  let updates = 0;
  const stop = subscribeCompletions(scope, () => { updates++; });
  setRecentCompletions(scope, [completion('from-background')]);
  assert.equal(recentCompletions(scope)[0].projectId, 'from-background');
  const restored = recentCompletions(scope);
  setRecentCompletions(scope, [completion('from-background')]);
  assert.equal(recentCompletions(scope), restored);
  assert.equal(updates, 1, 'equivalent polling snapshots should not render again');
  assert.deepEqual(recentCompletions('different-account'), []);
  stop();
});
