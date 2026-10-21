import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageTrace, ProjectState } from '../src/api/types';
import { confirmationCost, formatPoints, INSUFFICIENT_POINTS_TEXT, pointsValue, POINTS_PER_CNY, REGENERATE_DIRECTIONS_TEXT, traceSummary } from '../src/lib/transparency';

const trace: MessageTrace = { tool: 'write_script', model: 'local-text', duration_ms: 4800, cost_cny: 0.01, refs: [], steps: [{ label: '写脚本', duration_ms: 4800 }] };
const state: ProjectState = { stage: 'script', garments: [], directions: [], images: [], active_jobs: [], pending_action: { type: 'confirm_script', prompt: '确认出图', estimated_cost_cny: 4.32 }, budget: { tier: 'free', daily_budget_cny: 10, today_cost_cny: 5.68, remaining_cny: 4.32 } };

test('points use the new wire amount first and convert older responses at ten points per unit', () => {
  assert.equal(POINTS_PER_CNY, 10);
  assert.equal(pointsValue(15, 100), 15);
  assert.equal(pointsValue(0, 100), 0);
  assert.equal(pointsValue(undefined, 1.5), 15);
  assert.equal(pointsValue(undefined, 0), 0);
  for (const amount of [undefined, NaN, Infinity, -1]) assert.equal(pointsValue(undefined, amount), undefined);
  assert.equal(pointsValue(NaN, 1.5), 15);
});

test('point formatting keeps a single decimal and preserves tiny nonzero usage', () => {
  assert.equal(formatPoints(0), '0 点');
  assert.equal(formatPoints(15), '15 点');
  assert.equal(formatPoints(0.3), '0.3 点');
  assert.equal(formatPoints(43.24), '43.2 点');
  assert.equal(formatPoints(43.28), '43.3 点');
  assert.equal(formatPoints(0.099), '不到 0.1 点');
  assert.equal(formatPoints(0.004), '不到 0.1 点');
  assert.equal(formatPoints(0.1), '0.1 点');
});

test('trace uses a readable capability name, prefers point amounts, and preserves tiny usage', () => {
  assert.equal(traceSummary(trace), '用了 写脚本 · 4.8s · 0.1 点');
  assert.equal(traceSummary({ ...trace, cost_points: 0.3 }), '用了 写脚本 · 4.8s · 0.3 点');
  assert.equal(traceSummary({ ...trace, tool: 'future_tool' as MessageTrace['tool'], cost_cny: 0.0004 }), '用了 智能体处理 · 4.8s · 不到 0.1 点');
  assert.equal(traceSummary({ ...trace, cost_points: 0 }), '用了 写脚本 · 4.8s · 0 点');
});

test('confirmation includes exact estimate and budget, allowing equal funds and rejecting a shortfall', () => {
  assert.deepEqual(confirmationCost(state, 'confirm_script'), { estimate: 43.2, remaining: 43.2, insufficient: false, label: '预计 43.2 点 · 今日还有 43.2 点' });
  assert.equal(confirmationCost({ ...state, budget: { ...state.budget!, remaining_cny: 4.31 } }, 'confirm_script')?.insufficient, true);
  assert.equal(confirmationCost({ ...state, pending_action: { ...state.pending_action!, estimated_cost_cny: 0 }, budget: { ...state.budget!, remaining_cny: 0 } }, 'confirm_script')?.insufficient, false);
  assert.equal(confirmationCost(state, 'confirm_video'), undefined);
});

test('confirmation compares the preferred point fields before display rounding', () => {
  const pointsState: ProjectState = {
    ...state,
    pending_action: { ...state.pending_action!, estimated_cost_points: 15 },
    budget: { ...state.budget!, remaining_points: 585 },
  };
  assert.deepEqual(confirmationCost(pointsState, 'confirm_script'), { estimate: 15, remaining: 585, insufficient: false, label: '预计 15 点 · 今日还有 585 点' });
  assert.equal(confirmationCost({ ...pointsState, budget: { ...pointsState.budget!, remaining_points: 14.999 } }, 'confirm_script')?.insufficient, true);
  assert.equal(confirmationCost({ ...pointsState, pending_action: { ...pointsState.pending_action!, estimated_cost_points: 0 }, budget: { ...pointsState.budget!, remaining_points: 0 } }, 'confirm_script')?.insufficient, false);
  assert.equal(INSUFFICIENT_POINTS_TEXT, '今日点数不够了，明天 00:00 恢复');
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
