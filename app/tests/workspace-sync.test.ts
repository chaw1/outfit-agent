import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceHistorySync } from '../src/api/workspaceSync';
import type { Message } from '../src/api/types';

function message(id: string): Message {
  return { id, role: 'assistant', text: id, cards: [], created_at: '2026-10-20T01:00:00Z' };
}

test('last_message_id changes trigger history fetches, including a proactive message after jobs become empty', async () => {
  const sync = new WorkspaceHistorySync();
  let historyCalls = 0;
  const histories = [[message('m1')], [message('m1'), message('proactive')]];
  const poll = async (last_message_id: string) => {
    sync.observeState({ last_message_id });
    if (!sync.needsHistory(false)) return;
    const messages = histories[historyCalls++]!;
    if (sync.canApplyHistory(messages)) sync.appliedHistory(messages);
  };
  await poll('m1');
  await poll('m1');
  assert.equal(historyCalls, 1);
  // The state poll continues while idle, so the last job clearing cannot hide this marker.
  await poll('proactive');
  assert.equal(historyCalls, 2);
  assert.equal(sync.needsHistory(false), false);
});

test('a marker discovered during SSE remains pending until streaming ends and history includes it', () => {
  const sync = new WorkspaceHistorySync();
  sync.observeState({ last_message_id: 'm1' });
  sync.appliedHistory([message('m1')]);
  sync.observeState({ last_message_id: 'worker-during-stream' });
  assert.equal(sync.needsHistory(true, true), false);
  assert.equal(sync.needsHistory(false), true);
  assert.equal(sync.canApplyHistory([message('m1')]), false);
  assert.equal(sync.needsHistory(false), true);
  const history = [message('m1'), message('worker-during-stream')];
  assert.equal(sync.canApplyHistory(history), true);
  sync.appliedHistory(history);
  assert.equal(sync.needsHistory(false), false);
});

test('a newer concurrent marker cannot be acknowledged by an older messages response', () => {
  const sync = new WorkspaceHistorySync();
  sync.observeState({ last_message_id: 'm1' });
  sync.observeState({ last_message_id: 'm2' });
  assert.equal(sync.canApplyHistory([message('m1')]), false);
  assert.equal(sync.needsHistory(false), true);
  const latest = [message('m1'), message('m2')];
  assert.equal(sync.canApplyHistory(latest), true);
  sync.appliedHistory(latest);
  assert.equal(sync.needsHistory(false), false);
});

test('legacy states without a marker still allow forced initial, reconnect and recovery history refresh', () => {
  const sync = new WorkspaceHistorySync();
  sync.observeState({});
  assert.equal(sync.needsHistory(false), false);
  assert.equal(sync.needsHistory(false, true), true);
  assert.equal(sync.canApplyHistory([message('legacy')]), true);
  sync.appliedHistory([message('legacy')]);
  assert.equal(sync.needsHistory(false, true), true);
});
