import type { Project } from '../api/types';

const activeStatuses = new Set(['generating', 'waiting_you', 'ready']);
const recentFirst = (left: Project, right: Project) => (right.progress?.updated_at || right.updated_at).localeCompare(left.progress?.updated_at || left.updated_at);

export function inProgressProjects(items: readonly Project[]): Project[] {
  return items.filter(item => activeStatuses.has(item.progress?.status ?? '')).sort(recentFirst);
}

export function otherProjects(items: readonly Project[]): Project[] {
  return items.filter(item => !activeStatuses.has(item.progress?.status ?? '')).sort(recentFirst);
}
