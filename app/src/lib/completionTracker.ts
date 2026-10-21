import type { Job, ProjectState } from '../api/types';

export interface WatchedProject { id: string; title: string; jobs: Job[]; announced: string[]; ignoredJobIds?: string[]; autoActive?: boolean }
export interface Completion { projectId: string; title: string; kind: Job['kind']; jobIds: string[]; body: string }
export interface GenerationApi { state(id: string): Promise<ProjectState>; job(id: string): Promise<Job> }
export interface NotificationSession { api: GenerationApi; token: string; baseUrl: string; userId: string }
export interface SavedGenerations { owner: string; baseUrl: string; projects: WatchedProject[]; recent?: Completion[] }
export type CompletionListener = (completion: Completion) => void;
export const isPending = (job: Pick<Job, 'status'>) => job.status === 'queued' || job.status === 'running';
export const needsGenerationCheck = (project: WatchedProject) => Boolean(project.autoActive) || project.jobs.some(job => isPending(job) || (job.status === 'succeeded' && !project.announced.includes(job.id)));
export const notificationOwner = (value: Pick<NotificationSession, 'baseUrl' | 'userId'>) => JSON.stringify([value.baseUrl.replace(/\/+$/, ''), value.userId]);
const progressJob = ({ id, project_id, kind, status, created_at, updated_at }: Job): Job => ({ id, project_id, kind, status, created_at, updated_at });

/** Incoming events are chronological; retain the newest completion per project. */
export function appendRecentCompletions(previous: readonly Completion[], incoming: readonly Completion[]): Completion[] {
  const seen = new Set<string>();
  return [...incoming].reverse().concat(previous).filter(completion => {
    if (seen.has(completion.projectId)) return false;
    seen.add(completion.projectId);
    return true;
  }).slice(0, 5);
}

/** Persist only progress, never credentials or signed media addresses. */
export function trackState(previous: WatchedProject | undefined, id: string, title: string, state: ProjectState): WatchedProject {
  const jobs = new Map((previous?.jobs ?? []).map(job => [job.id, progressJob(job)]));
  const ignored = new Set(previous?.ignoredJobIds ?? []);
  // Previews share kind=image but are not outfit images. Remember their IDs while
  // moving through direction/script, and limit unknown image jobs to pending shots.
  const imageSlots = state.images.filter(image => isPending(image) && !image.parent_id).length;
  const candidates = state.active_jobs.filter(job => job.kind === 'image' && !ignored.has(job.id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const imageIds = new Set(candidates.slice(0, imageSlots).map(job => job.id));
  for (const job of state.active_jobs) {
    if (job.kind === 'image' && !jobs.has(job.id) && !imageIds.has(job.id)) { ignored.add(job.id); continue; }
    if (ignored.has(job.id)) continue;
    jobs.set(job.id, progressJob(job));
  }
  // Auto can enqueue its next batch while no jobs are currently running. Keep
  // watching through those gaps, including when the user leaves at directions.
  if (state.mode === 'auto' && state.video?.job_id) {
    const previousVideo = jobs.get(state.video.job_id);
    jobs.set(state.video.job_id, { id: state.video.job_id, project_id: id, kind: 'video', status: state.video.status,
      created_at: previousVideo?.created_at ?? state.auto?.started_at ?? '', updated_at: previousVideo?.updated_at ?? '' });
  }
  return { autoActive: state.mode === 'auto' && state.auto?.active === true, id, title: title === '这组片' && previous?.title ? previous.title : title, jobs: [...jobs.values()], announced: previous?.announced ?? [], ignoredJobIds: [...ignored] };
}

export function completedGroups(watched: WatchedProject, updates: Job[]): { watched: WatchedProject; completions: Completion[] } {
  const byId = new Map(updates.map(job => [job.id, job]));
  const jobs = watched.jobs.map(job => progressJob(byId.get(job.id) ?? job));
  const announced = new Set(watched.announced);
  const completions: Completion[] = [];
  const images = jobs.filter(job => (job.kind === 'image' || job.kind === 'edit') && !announced.has(job.id));
  const videos = jobs.filter(job => job.kind === 'video' && !announced.has(job.id));
  for (const group of [images, videos]) {
    if (!group.length || group.some(isPending)) continue;
    const succeeded = group.filter(job => job.status === 'succeeded');
    group.forEach(job => announced.add(job.id));
    if (!succeeded.length) continue;
    // Automatic repairs belong to the current image batch and must finish before
    // its single alert. Later manual edits form a fresh edit-only group.
    const kind = group.some(job => job.kind === 'image') ? 'image' : group[0].kind;
    const count = succeeded.filter(job => job.kind === 'image').length;
    completions.push({ projectId: watched.id, title: watched.title, kind, jobIds: succeeded.map(job => job.id), body: kind === 'video' ? '短视频已完成，来看看吧。' : kind === 'edit' ? '改图已完成，新版本可以查看了。' : `${count} 张穿搭图已完成，来挑选吧。` });
  }
  return { watched: { ...watched, jobs, announced: [...announced] }, completions };
}

export function notificationProject(data: Record<string, unknown> | undefined, expectedOwner: string): string | undefined {
  return data?.owner === expectedOwner && typeof data.projectId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(data.projectId) ? data.projectId : undefined;
}

export function parseSavedGenerations(raw: string | null): SavedGenerations | undefined {
  try {
    const saved = JSON.parse(raw || 'null') as SavedGenerations | null;
    if (!saved || typeof saved.owner !== 'string' || typeof saved.baseUrl !== 'string' || !Array.isArray(saved.projects)) return undefined;
    if (saved.projects.some(project => typeof project.id !== 'string' || typeof project.title !== 'string' || !Array.isArray(project.jobs) || !Array.isArray(project.announced) || project.jobs.some(job => typeof job.id !== 'string' || !['image', 'edit', 'video'].includes(job.kind) || !['queued', 'running', 'succeeded', 'failed'].includes(job.status)))) return undefined;
    if (saved.recent !== undefined && (!Array.isArray(saved.recent) || saved.recent.some(completion => !completion || typeof completion !== 'object' ||
      typeof completion.projectId !== 'string' || typeof completion.title !== 'string' || typeof completion.body !== 'string' ||
      !['image', 'edit', 'video'].includes(completion.kind) || !Array.isArray(completion.jobIds) || !completion.jobIds.every(id => typeof id === 'string')))) return undefined;
    return { ...saved, projects: saved.projects.map(project => ({ ...project, jobs: project.jobs.map(progressJob) })),
      ...(saved.recent !== undefined ? { recent: appendRecentCompletions(saved.recent, []).map(({ projectId, title, kind, jobIds, body }) => ({ projectId, title, kind, jobIds: [...jobIds], body })) } : {}) };
  } catch { return undefined; }
}

export async function checkGeneration(api: GenerationApi, project: WatchedProject) {
  const fresh = await api.state(project.id);
  let tracked = trackState(project, project.id, project.title, fresh);
  const updates = await Promise.all(tracked.jobs.filter(isPending).map(job => api.job(job.id)));
  if (updates.some(job => !isPending(job))) {
    // A worker may queue an automatic repair between the state read and the job
    // read. Discover that new job before announcing the original batch.
    tracked = trackState(tracked, project.id, project.title, await api.state(project.id));
  }
  return completedGroups(tracked, updates);
}

export interface CompletionDelivery {
  isForeground(): boolean;
  isCurrent(): boolean;
  permissionGranted(): Promise<boolean>;
  foreground(completion: Completion): void;
  schedule(completion: Completion, owner: string): Promise<void>;
}
export async function deliverCompletion(completion: Completion, owner: string, delivery: CompletionDelivery): Promise<void> {
  if (!delivery.isCurrent()) return;
  if (delivery.isForeground()) { delivery.foreground(completion); return; }
  if (!await delivery.permissionGranted() || !delivery.isCurrent()) return;
  // Reading OS permission can yield while the user returns to the app.
  if (delivery.isForeground()) { delivery.foreground(completion); return; }
  await delivery.schedule(completion, owner);
}

/** Shared serialized controller; native adapters supply storage and OS delivery. */
export function createGenerationRuntime(dependencies: {
  load?: () => Promise<string | null>;
  save?: (value: string | null) => Promise<void>;
  onCompletions?: (scope: string, values: readonly Completion[]) => void;
  deliver: (completion: Completion, owner: string, isCurrent: () => boolean, listener?: CompletionListener) => Promise<void>;
}) {
  let session: NotificationSession | null = null;
  let listener: CompletionListener | undefined;
  let watched = new Map<string, WatchedProject>();
  let recent: Completion[] = [];
  let revision = 0;
  let queue = Promise.resolve();
  let polling = false;
  const serialize = (operation: () => Promise<void>) => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
  const persist = async (current: NotificationSession, epoch: number) => {
    if (epoch !== revision) return;
    const saved: SavedGenerations = { owner: notificationOwner(current), baseUrl: current.baseUrl, projects: [...watched.values()], recent };
    await dependencies.save?.(JSON.stringify(saved));
  };
  const publishRecent = (current: NotificationSession, epoch: number) => {
    if (epoch !== revision) return;
    try { dependencies.onCompletions?.(notificationOwner(current), recent); }
    catch { /* A feed subscriber must not change notification delivery or retries. */ }
  };
  return {
    configure(value: NotificationSession | null, onComplete?: CompletionListener): Promise<void> {
      const previousOwner = session ? notificationOwner(session) : undefined;
      const epoch = ++revision;
      session = value; listener = onComplete;
      if (!value || previousOwner !== notificationOwner(value)) { watched.clear(); recent = []; }
      return serialize(async () => {
        if (epoch !== revision) return;
        if (!value) { await dependencies.save?.(null); return; }
        if (previousOwner !== notificationOwner(value)) {
          const saved = parseSavedGenerations(await dependencies.load?.() ?? null);
          if (epoch !== revision) return;
          if (saved?.owner === notificationOwner(value)) {
            watched = new Map(saved.projects.map(project => [project.id, project]));
            recent = saved.recent ?? [];
          }
        }
        await persist(value, epoch);
        publishRecent(value, epoch);
      });
    },
    observe(id: string, title: string, state: ProjectState): Promise<void> {
      const current = session;
      const epoch = revision;
      if (!current) return Promise.resolve();
      return serialize(async () => {
        if (epoch !== revision) return;
        watched.set(id, trackState(watched.get(id), id, title, state));
        await persist(current, epoch);
      });
    },
    async poll(): Promise<void> {
      const current = session;
      const epoch = revision;
      if (!current || polling) return;
      polling = true;
      try {
        await serialize(async () => {
          for (const project of watched.values()) {
            if (epoch !== revision) return;
            if (!needsGenerationCheck(project)) continue;
            try {
              const result = await checkGeneration(current.api, project);
              if (epoch !== revision) return;
              watched.set(project.id, result.watched);
              if (result.completions.length) recent = appendRecentCompletions(recent, result.completions);
              // Save deduplication before notifying; a relaunch must not repeat it.
              await persist(current, epoch);
              if (result.completions.length) publishRecent(current, epoch);
              for (const completion of result.completions) {
                try { await dependencies.deliver(completion, notificationOwner(current), () => epoch === revision, listener); }
                catch {
                  result.watched.announced = result.watched.announced.filter(id => !completion.jobIds.includes(id));
                  await persist(current, epoch);
                }
              }
            } catch (error) {
              if (epoch !== revision) return;
              if ((error as { status?: number }).status === 404) watched.delete(project.id);
              else watched.set(project.id, project);
            }
          }
          await persist(current, epoch);
        });
      } finally { polling = false; }
    },
    isCurrent: (value: NotificationSession) => session?.token === value.token && session?.baseUrl === value.baseUrl && session?.userId === value.userId,
    currentOwner: () => session ? notificationOwner(session) : undefined,
  };
}
