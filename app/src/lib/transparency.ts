import type { MessageTrace, PendingAction, ProjectState } from '../api/types';

const toolNames: Record<string, string> = {
  chat: '对话', analyze_garments: '看懂衣服', propose_directions: '提方向',
  write_script: '写脚本', revise_script: '改脚本', edit_image: '改图',
  write_note: '写笔记', generate_images: '出图', generate_video: '生成视频', restore_script: '恢复脚本',
};

export const REGENERATE_DIRECTIONS_TEXT = '换一组方向，保留我刚才说的偏好';
const validAmount = (amount: unknown): amount is number => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
export const seconds = (duration: number) => `${(duration / 1000).toFixed(1)}s`;
export function traceSummary(trace: MessageTrace): string {
  return `用了 ${toolNames[trace.tool] || '智能体处理'} · ${seconds(trace.duration_ms)} · ¥${trace.cost_cny.toFixed(trace.cost_cny > 0 && trace.cost_cny < 0.005 ? 4 : 2)}`;
}

export function confirmationCost(state: ProjectState | undefined, action: PendingAction['type']) {
  const estimate = state?.pending_action?.estimated_cost_cny;
  const remaining = state?.budget?.remaining_cny;
  if (state?.pending_action?.type !== action || !validAmount(estimate) || !validAmount(remaining)) return undefined;
  return {
    estimate, remaining,
    insufficient: estimate > remaining + 1e-8,
    label: `预计约 ¥${estimate.toFixed(2)} · 今日剩余 ¥${remaining.toFixed(2)}`,
  };
}
