import type { Action } from '../api/types';

export type QuickTool = 'background' | 'outpaint' | 'upscale';
export type OutpaintDirection = 'top' | 'bottom' | 'horizontal' | 'all';
export const QUICK_TOOL_NAMES: Record<QuickTool, string> = { background: '换背景', outpaint: '扩图', upscale: '高清' };
export const BACKGROUND_SCENES = ['街角', '咖啡馆窗边', '白盒子展厅', '海边傍晚', '地铁站', '纯色影棚'] as const;
export const OUTPAINT_DIRECTIONS: { label: string; value: OutpaintDirection }[] = [
  { label: '上', value: 'top' }, { label: '下', value: 'bottom' },
  { label: '左右', value: 'horizontal' }, { label: '四周', value: 'all' },
];

export function quickToolAction(imageId: string, preset: QuickTool, scene = '', direction: OutpaintDirection = 'all'): Extract<Action, { type: 'edit_image' }> {
  if (preset === 'background') {
    if (!scene.trim()) throw new Error('先选择或填写背景场景。');
    return { type: 'edit_image', image_id: imageId, preset, background: scene.trim(), instruction: `只换背景为 ${scene.trim()}，人物、服装、姿势、光线方向保持不变` };
  }
  return { type: 'edit_image', image_id: imageId, preset,
    instruction: preset === 'outpaint' ? '补全画面边缘的场景，人物与服装不变' : '将原图高清重绘为 2 倍尺寸，人物、服装、姿势与场景保持不变',
    ...(preset === 'outpaint' ? { direction } : {}),
  };
}
