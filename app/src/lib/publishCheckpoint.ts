import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { emptyPublishProgress, type PublishProgress } from './publish';

const sessions = new Map<string, PublishProgress>();
function storageKey(scope: string): string {
  let hash = 2166136261;
  for (const character of scope) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `outfit-publish-${(hash >>> 0).toString(16)}`;
}

/** Store media IDs only; note text, signed media URLs and credentials stay out of this file. */
export function readPublishCheckpoint(scope: string): PublishProgress {
  const cached = sessions.get(scope);
  if (cached) return { ...cached, savedImageIds: [...cached.savedImageIds], savedVideoKeys: [...cached.savedVideoKeys] };
  const progress = emptyPublishProgress();
  try {
    const key = storageKey(scope);
    const file = Platform.OS === 'web' ? undefined : new File(Paths.document, `${key}.json`);
    const raw = Platform.OS === 'web' ? localStorage.getItem(key) : file?.exists ? file.textSync() : null;
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.scope === scope) {
        progress.savedImageIds = Array.isArray(saved.savedImageIds) ? saved.savedImageIds.filter((id: unknown): id is string => typeof id === 'string') : [];
        progress.savedVideoKeys = Array.isArray(saved.savedVideoKeys) ? saved.savedVideoKeys.filter((id: unknown): id is string => typeof id === 'string') : [];
      }
    }
  } catch { /* 存储不可用时仍能在当前页面重试未完成项。 */ }
  sessions.set(scope, progress);
  return progress;
}

export function writePublishCheckpoint(scope: string, progress: PublishProgress): void {
  sessions.set(scope, { ...progress, savedImageIds: [...progress.savedImageIds], savedVideoKeys: [...progress.savedVideoKeys] });
  try {
    const key = storageKey(scope);
    const value = JSON.stringify({ scope, savedImageIds: progress.savedImageIds, savedVideoKeys: progress.savedVideoKeys });
    if (Platform.OS === 'web') localStorage.setItem(key, value);
    else {
      const file = new File(Paths.document, `${key}.json`);
      if (!file.exists) file.create({ intermediates: true });
      file.writeSync(value);
    }
  } catch { /* 已保存的媒体无需因为断点写入失败而再次保存。 */ }
}
