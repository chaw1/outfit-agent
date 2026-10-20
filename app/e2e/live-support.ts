import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';

export interface LiveCheckpoint {
  schema: 1;
  run: number;
  base: string;
  username: string;
  password: string;
  session?: string;
  registered?: boolean;
  projectId?: string;
  projectTitle: string;
  startedAt: string;
  completedAt?: string;
  completed: string[];
  timings: Record<string, number>;
  sent: Record<string, string>;
  data: Record<string, unknown>;
}

export const liveDirectory = path.resolve('screenshots-live');
export const checkpointFile = path.join(liveDirectory, 'checkpoint.json');

export function normalizeLiveBase(value: string) {
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('LIVE_API_BASE 必须是无凭证、无查询参数的完整服务地址。');
  return value.replace(/\/+$/, '').replace(/\/api$/, '');
}

/** A retry keeps the same project; only an explicit new run consumes another slot. */
export function selectLiveRun(previous: LiveCheckpoint | undefined, base: string, fresh: boolean): LiveCheckpoint {
  if (previous && previous.base !== base) throw new Error('断点属于其他服务；请人工确认归属并归档断点后再继续。');
  if (previous && !fresh) return previous;
  const run = (previous?.run ?? 0) + 1;
  if (run > 3) throw new Error('线上完整链路最多 3 遍，已到上限。');
  const unique = Date.now().toString(36);
  return {
    schema: 1, run, base, username: `live-${unique}`, password: `Live-${unique}-${Math.random().toString(36).slice(2)}!`,
    projectTitle: `秋日衬衫联调 ${unique}`, startedAt: new Date().toISOString(), completed: [], timings: {}, sent: {}, data: {},
  };
}

export async function readLiveCheckpoint() {
  try { return JSON.parse(await readFile(checkpointFile, 'utf8')) as LiveCheckpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function writePrivateCheckpoint(destination: string, content: string) {
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  // Also repair permissions on a temporary file left by an interrupted older save.
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

export async function saveLiveCheckpoint(checkpoint: LiveCheckpoint, destination = checkpointFile) {
  const directory = path.dirname(destination);
  const privateDirectory = path.join(directory, 'private');
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await chmod(privateDirectory, 0o700);
  const content = `${JSON.stringify(checkpoint, null, 2)}\n`;
  // Preserve a run created before private archives existed, before advancing the latest pointer.
  try {
    const previousContent = await readFile(destination, 'utf8');
    const previous = JSON.parse(previousContent) as LiveCheckpoint;
    if (previous.run !== checkpoint.run) await writePrivateCheckpoint(path.join(privateDirectory, `run-${previous.run}.json`), previousContent);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writePrivateCheckpoint(path.join(privateDirectory, `run-${checkpoint.run}.json`), content);
  await writePrivateCheckpoint(destination, content);
}

/** Persist before a possible paid send; failed preparation alone must remain retryable. */
export async function performLiveOnce(
  checkpoint: LiveCheckpoint,
  key: string,
  persist: () => Promise<void>,
  work: () => Promise<void>,
  observeRequest: (observed: () => void) => () => void,
): Promise<void> {
  if (checkpoint.sent[key]) return;
  let requestObserved = false;
  const stopObserving = observeRequest(() => { requestObserved = true; });
  checkpoint.sent[key] = new Date().toISOString();
  try {
    await persist();
    await work();
  } catch (error) {
    // Once the browser emitted the request, its outcome may be unknown: never replay it.
    if (!requestObserved) { delete checkpoint.sent[key]; await persist(); }
    throw error;
  } finally { stopObserving(); }
}

export function sanitizeLiveEvidence(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s"<>]+/g, candidate => {
      try { const url = new URL(candidate); ['sig', 'exp', 'token'].forEach(key => url.searchParams.delete(key)); return url.toString(); }
      catch { return candidate; }
    }).replace(/Bearer\s+[^\s"]+/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(sanitizeLiveEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(token|password|authorization|cookie|username)$/i.test(key) ? '[REDACTED]' : sanitizeLiveEvidence(item)]));
  return value;
}
