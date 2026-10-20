import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageTrace, ProjectState } from '../src/api/types';
import { confirmationCost, REGENERATE_DIRECTIONS_TEXT, traceSummary } from '../src/lib/transparency';

const trace: MessageTrace = { tool: 'write_script', model: 'local-text', duration_ms: 4800, cost_cny: 0.01, refs: [], steps: [{ label: '写脚本', duration_ms: 4800 }] };
const state: ProjectState = { stage: 'script', garments: [], directions: [], images: [], active_jobs: [], pending_action: { type: 'confirm_script', prompt: '确认出图', estimated_cost_cny: 4.32 }, budget: { tier: 'free', daily_budget_cny: 10, today_cost_cny: 5.68, remaining_cny: 4.32 } };

test('trace uses a readable capability name and preserves tiny nonzero costs', () => {
  assert.equal(traceSummary(trace), '用了 写脚本 · 4.8s · ¥0.01');
  assert.equal(traceSummary({ ...trace, tool: 'future_tool' as MessageTrace['tool'], cost_cny: 0.0004 }), '用了 智能体处理 · 4.8s · ¥0.0004');
});

test('confirmation includes exact estimate and budget, allowing equal funds and rejecting a shortfall', () => {
  assert.deepEqual(confirmationCost(state, 'confirm_script'), { estimate: 4.32, remaining: 4.32, insufficient: false, label: '预计约 ¥4.32 · 今日剩余 ¥4.32' });
  assert.equal(confirmationCost({ ...state, budget: { ...state.budget!, remaining_cny: 4.31 } }, 'confirm_script')?.insufficient, true);
  assert.equal(confirmationCost({ ...state, pending_action: { ...state.pending_action!, estimated_cost_cny: 0 }, budget: { ...state.budget!, remaining_cny: 0 } }, 'confirm_script')?.insufficient, false);
  assert.equal(confirmationCost(state, 'confirm_video'), undefined);
});

test('legacy and invalid cost metadata hide the prompt without disabling old confirmation', () => {
  for (const value of [undefined, { ...state, budget: undefined }, { ...state, pending_action: undefined }, { ...state, pending_action: { ...state.pending_action!, estimated_cost_cny: undefined } }]) {
    assert.equal(confirmationCost(value, 'confirm_script'), undefined);
  }
  for (const amount of [NaN, Infinity, -1]) {
    assert.equal(confirmationCost({ ...state, budget: { ...state.budget!, remaining_cny: amount } }, 'confirm_script'), undefined);
    assert.equal(confirmationCost({ ...state, pending_action: { ...state.pending_action!, estimated_cost_cny: amount } }, 'confirm_script'), undefined);
  }
  assert.equal(REGENERATE_DIRECTIONS_TEXT, '换一组方向，保留我刚才说的偏好');
});
