import type { MessageTrace, PendingAction, ProjectState } from '../api/types';

const toolNames: Record<string, string> = {
  chat: '对话', analyze_garments: '看懂衣服', propose_directions: '提方向',
  write_script: '写脚本', revise_script: '改脚本', edit_image: '改图',
  write_note: '写笔记', generate_images: '出图', generate_video: '生成视频', restore_script: '恢复脚本',
  background: '换背景', outpaint: '扩图', upscale: '高清',
};

export const REGENERATE_DIRECTIONS_TEXT = '换一组方向，保留我刚才说的偏好';
export const POINTS_PER_CNY = 10;
export const INSUFFICIENT_POINTS_TEXT = '今日点数不够了，明天 00:00 恢复';
const validAmount = (amount: unknown): amount is number => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;

export function pointsValue(points?: number, cny?: number): number | undefined {
  if (validAmount(points)) return points;
  return validAmount(cny) ? cny * POINTS_PER_CNY : undefined;
}

export function formatPoints(amount: number): string {
  if (amount > 0 && amount < 0.1) return '不到 0.1 点';
  return `${Number(amount.toFixed(1))} 点`;
}

export const seconds = (duration: number) => `${(duration / 1000).toFixed(1)}s`;
export function traceSummary(trace: MessageTrace): string {
  const amount = pointsValue(trace.cost_points, trace.cost_cny);
  return `用了 ${toolNames[trace.tool] || '智能体处理'} · ${seconds(trace.duration_ms)}${amount === undefined ? '' : ` · ${formatPoints(amount)}`}`;
}

/** 额度大到用不完时（演示或内部账号），不把一长串数字摆给用户看。 */
export const AMPLE_POINTS = 100_000;
export function remainingLabel(remaining: number): string {
  return remaining >= AMPLE_POINTS ? '今日额度充足' : `今日还有 ${formatPoints(remaining)}`;
}

export function confirmationCost(state: ProjectState | undefined, action: PendingAction['type']) {
  const estimate = pointsValue(state?.pending_action?.estimated_cost_points, state?.pending_action?.estimated_cost_cny);
  const remaining = pointsValue(state?.budget?.remaining_points, state?.budget?.remaining_cny);
  if (state?.pending_action?.type !== action || !validAmount(estimate) || !validAmount(remaining)) return undefined;
  return {
    estimate, remaining,
    insufficient: estimate > remaining + 1e-8,
    label: `预计 ${formatPoints(estimate)} · ${remainingLabel(remaining)}`,
  };
}
