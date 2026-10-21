export const LEGAL_VERSION = '2026-10-21';
export const PRIVACY_CONSENT_KEY = 'outfit.privacy-consent';

export interface ConsentStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export async function hasPrivacyConsent(storage: ConsentStorage): Promise<boolean> {
  try { return await storage.getItem(PRIVACY_CONSENT_KEY) === LEGAL_VERSION; }
  catch { return false; }
}

export async function savePrivacyConsent(storage: ConsentStorage): Promise<void> {
  await storage.setItem(PRIVACY_CONSENT_KEY, LEGAL_VERSION);
}

export type PrivacyState = 'loading' | 'required' | 'declined' | 'accepted';
export function canEnterApp(state: PrivacyState): boolean { return state === 'accepted'; }
