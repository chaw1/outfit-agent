import { ApiError, type ApiClient } from '../api/client';
import type { CreateProjectInput, Project } from '../api/types';

export interface ProjectCreationRecovery {
  input: CreateProjectInput;
  /** null means the list could not be checked yet. */
  projects: Project[] | null;
}

export async function checkProjectCreation(api: Pick<ApiClient, 'projects'>, input: CreateProjectInput): Promise<ProjectCreationRecovery> {
  const projects = await api.projects();
  return { input, projects: projects.filter(project => project.title === input.title && project.brand === input.brand && project.brief === input.brief) };
}

/** A timed-out write may have succeeded. Refresh first, then let the user decide. */
export async function createProjectWithRecovery(api: Pick<ApiClient, 'createProject' | 'projects'>, input: CreateProjectInput): Promise<
  { kind: 'created'; project: Project } | { kind: 'uncertain'; recovery: ProjectCreationRecovery }
> {
  try { return { kind: 'created', project: await api.createProject(input) }; }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'TIMEOUT') throw error;
    try { return { kind: 'uncertain', recovery: await checkProjectCreation(api, input) }; }
    catch { return { kind: 'uncertain', recovery: { input, projects: null } }; }
  }
}

export function projectCreationRecoveryText(recovery: ProjectCreationRecovery): string {
  if (recovery.projects === null) return '创建等待超时，项目列表还没刷新成功。先再查一次，确认后再新建。';
  return recovery.projects.length ? '已刷新项目列表，发现相同项目。先打开确认，避免重复新建。'
    : '已刷新项目列表，暂时没找到相同项目。可再查一次，或确认重新新建。';
}
