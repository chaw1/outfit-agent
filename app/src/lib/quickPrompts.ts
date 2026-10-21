import type { ProjectState } from '../api/types';

/**
 * 对话输入框上方的快捷话术：按阶段给三句最常说的话，点一下就发出去。
 * 只放不花钱的自由对话；要花钱的确认仍然走卡片上的确认按钮。
 */
export function quickPrompts(state: Pick<ProjectState, 'stage' | 'mode' | 'video' | 'active_jobs'> | undefined): string[] {
  if (!state || state.mode === 'auto') return [];
  if (state.active_jobs.length) return [];
  switch (state.stage) {
    case 'brief':
    case 'direction':
      return ['换一组方向', '搭配想再简单一点', '想要更日常的通勤感'];
    case 'script':
      return ['下装配浅色直筒裤', '鞋换成乐福鞋', '镜头少一点，留三个'];
    case 'images':
      return ['整体再松弛一点', '帮我挑最适合封面的一张', '想换一种氛围'];
    case 'note':
      return ['正文短一点，100 字以内', '标题更抓人一些', '标签换成通勤相关'];
    case 'done':
      return state.video ? ['再做一条短片', '正文再精简一半', '换个更口语的标题'] : ['正文再精简一半', '换个更口语的标题'];
    default:
      return [];
  }
}
