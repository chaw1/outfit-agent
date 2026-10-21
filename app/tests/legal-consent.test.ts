import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGAL_VERSION, PRIVACY_CONSENT_KEY, canEnterApp, hasPrivacyConsent, savePrivacyConsent, type ConsentStorage } from '../src/lib/legalConsent';

test('privacy consent persists the exact version and survives a new read', async () => {
  const data = new Map<string, string>();
  const storage: ConsentStorage = { getItem: async key => data.get(key) ?? null, setItem: async (key, value) => { data.set(key, value); } };
  assert.equal(await hasPrivacyConsent(storage), false);
  await savePrivacyConsent(storage);
  assert.equal(data.get(PRIVACY_CONSENT_KEY), LEGAL_VERSION);
  assert.equal(await hasPrivacyConsent(storage), true);
  data.set(PRIVACY_CONSENT_KEY, 'old-version');
  assert.equal(await hasPrivacyConsent(storage), false);
});

test('first launch stays gated while loading, declined, outdated or storage is unavailable', async () => {
  for (const state of ['loading', 'required', 'declined'] as const) assert.equal(canEnterApp(state), false);
  assert.equal(canEnterApp('accepted'), true);
  const unavailable: ConsentStorage = { getItem: async () => { throw new Error('unavailable'); }, setItem: async () => { throw new Error('unavailable'); } };
  assert.equal(await hasPrivacyConsent(unavailable), false);
  await assert.rejects(savePrivacyConsent(unavailable), /unavailable/);
  assert.equal(await hasPrivacyConsent(unavailable), false);
});
