import type { Card, Job, JobStatus, OutfitImage, ProjectState } from './types';

export const emptyProjectState = (): ProjectState => ({ stage: 'brief', garments: [], directions: [], images: [], active_jobs: [] });

/** A card is a complete snapshot: replace the entire prior object at the same position. */
export function mergeCards(previous: readonly Card[], incoming: readonly Card[]): Card[] {
  const result = [...previous];
  const positions = new Map(result.map((card, index) => [card.id, index]));
  for (const card of incoming) {
    const index = positions.get(card.id);
    if (index === undefined) { positions.set(card.id, result.length); result.push(card); }
    else result[index] = card;
  }
  return result;
}

const statusRank: Record<JobStatus, number> = { queued: 0, running: 1, succeeded: 2, failed: 2 };

function acceptStatus(previous: JobStatus, incoming: JobStatus): boolean {
  if (statusRank[incoming] < statusRank[previous]) return false;
  return statusRank[previous] !== 2 || previous === incoming;
}

export function mergeJobs(previous: readonly Job[], incoming: readonly Job[]): Job[] {
  const result = [...previous];
  const positions = new Map(result.map((job, index) => [job.id, index]));
  for (const job of incoming) {
    const index = positions.get(job.id);
    if (index === undefined) { positions.set(job.id, result.length); result.push(job); continue; }
    const current = result[index];
    if (!current || !acceptStatus(current.status, job.status)) continue;
    if (current.status === job.status && job.updated_at < current.updated_at) continue;
    result[index] = { ...current, ...job };
  }
  return result;
}

export function mergeImages(previous: readonly OutfitImage[], incoming: readonly OutfitImage[]): OutfitImage[] {
  const result = [...previous];
  const positions = new Map(result.map((image, index) => [image.id, index]));
  for (const image of incoming) {
    const index = positions.get(image.id);
    if (index === undefined) { positions.set(image.id, result.length); result.push(image); continue; }
    const current = result[index];
    if (current && acceptStatus(current.status, image.status)) result[index] = { ...current, ...image };
  }
  return result;
}

/** Image progress can arrive after a note, video or script restore; it only extends the image list. */
export function stateWithCard(previous: ProjectState | undefined, card: Card): ProjectState {
  const state = previous ?? emptyProjectState();
  switch (card.type) {
    case 'references': return state;
    case 'garments': return { ...state, garments: card.items };
    case 'directions': return { ...state, stage: 'direction', directions: card.options, pending_action: undefined };
    case 'script': return { ...state, stage: 'script', script: card, pending_action: undefined };
    case 'images': {
      const advance = state.stage === 'brief' || state.stage === 'direction' || (state.stage === 'script' && state.script?.status !== 'draft');
      return { ...state, stage: advance ? 'images' : state.stage, images: mergeImages(state.images, card.items) };
    }
    case 'note': return { ...state, stage: state.stage === 'video' || state.stage === 'done' ? state.stage : 'note', note: card, pending_action: undefined };
    case 'video': return { ...state, stage: card.status === 'succeeded' ? 'done' : 'video', video: card, pending_action: null };
  }
}

/** Restore structured content even when reconnecting without historical card events. */
export function cardsFromState(state: ProjectState): Card[] {
  const cards: Card[] = [];
  if (state.garments.length) cards.push({ id: 'state:garments', type: 'garments', items: state.garments });
  if (state.directions.length) cards.push({ id: 'state:directions', type: 'directions', options: state.directions });
  if (state.script) cards.push({ ...state.script, id: 'state:script', type: 'script' });
  if (state.images.length) cards.push({ id: 'state:images', type: 'images', items: state.images });
  if (state.note) cards.push({ ...state.note, id: 'state:note', type: 'note' });
  if (state.video) cards.push({ ...state.video, id: 'state:video', type: 'video' });
  return cards;
}

/** Polling refreshes the most recent card of each kind, retaining its stable event id. */
export function mergeStateIntoCards(previous: readonly Card[], state: ProjectState): Card[] {
  const result = [...previous];
  for (const restored of cardsFromState(state)) {
    let index = -1;
    for (let i = result.length - 1; i >= 0; i -= 1) {
      if (result[i]?.type === restored.type) { index = i; break; }
    }
    const current = result[index];
    if (current?.type === 'directions' && restored.type === 'directions') {
      // Polling supplies the options; the regeneration estimate belongs to its card.
      const estimate = restored.regenerate_estimate_cny ?? current.regenerate_estimate_cny;
      result[index] = { ...restored, id: current.id, ...(estimate !== undefined ? { regenerate_estimate_cny: estimate } : {}) };
    } else if (current) result[index] = { ...restored, id: current.id };
    else result.push(restored);
  }
  return result;
}

/** Active jobs are authoritative; completed jobs disappearing must clear the progress indicator. */
export function mergeProjectState(previous: ProjectState | undefined, incoming: ProjectState): ProjectState {
  if (!previous) return incoming;
  const jobs = mergeJobs(previous.active_jobs, incoming.active_jobs);
  const incomingJobIds = new Set(incoming.active_jobs.map((job) => job.id));
  return {
    ...incoming,
    images: mergeImages(previous.images, incoming.images),
    active_jobs: jobs.filter((job) => incomingJobIds.has(job.id)),
  };
}
