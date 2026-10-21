import type { AutoState, AutoStep } from '../api/types';

export const AUTO_STEPS: readonly { step: AutoStep; label: string }[] = [
  { step: 'directions', label: '找方向' }, { step: 'script', label: '写脚本' },
  { step: 'images', label: '出图' }, { step: 'note', label: '写笔记' },
  { step: 'video', label: '做视频' }, { step: 'done', label: '出好了' },
];
export function autoProgress(auto: AutoState) {
  const index = Math.max(0, AUTO_STEPS.findIndex(value => value.step === auto.step));
  return {
    index, percent: auto.step === 'done' ? 100 : Math.round(index / (AUTO_STEPS.length - 1) * 100),
    steps: AUTO_STEPS.map((value, position) => ({ ...value, completed: position < index || auto.step === 'done', current: position === index && auto.step !== 'done' })),
  };
}
