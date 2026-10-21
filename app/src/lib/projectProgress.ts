import type { Project, Stage } from '../api/types';

const activeStatuses = new Set(['generating', 'waiting_you', 'ready']);
export const compareProjects = (left: Project, right: Project): number => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
  || (right.progress?.updated_at || right.updated_at).localeCompare(left.progress?.updated_at || left.updated_at);

export function inProgressProjects(items: readonly Project[]): Project[] {
  return items.filter(item => activeStatuses.has(item.progress?.status ?? '')).sort(compareProjects);
}

export function otherProjects(items: readonly Project[]): Project[] {
  return items.filter(item => !activeStatuses.has(item.progress?.status ?? '')).sort(compareProjects);
}

const stageOrder: readonly Stage[] = ['brief', 'direction', 'script', 'images', 'note', 'video', 'done'];

/** 片场列表的阶段筛选项：只列出现过的阶段，按流程顺序，带数量。 */
export function stageFilters(items: readonly Project[]): { stage: Stage; count: number }[] {
  return stageOrder.map(stage => ({ stage, count: items.filter(item => item.stage === stage).length })).filter(entry => entry.count > 0);
}

export function filterByStage(items: readonly Project[], stage: Stage | ''): Project[] {
  return stage ? items.filter(item => item.stage === stage) : [...items];
}
