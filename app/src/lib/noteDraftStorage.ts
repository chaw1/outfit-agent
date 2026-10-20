import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import type { DraftStorage } from './noteDraft';

/** Drafts contain user-authored text and media IDs, never tokens or signed URLs. */
export const localDraftStorage: DraftStorage = {
  getItem(key) {
    if (Platform.OS === 'web') return localStorage.getItem(key);
    const file = new File(Paths.document, `${key}.json`);
    return file.exists ? file.textSync() : null;
  },
  setItem(key, value) {
    if (Platform.OS === 'web') { localStorage.setItem(key, value); return; }
    const file = new File(Paths.document, `${key}.json`);
    if (!file.exists) file.create({ intermediates: true });
    file.writeSync(value);
  },
};
