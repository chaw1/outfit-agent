import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';

test('account requests preserve contract fields and public recovery does not carry a token', async () => {
  const calls: { path: string; method: string; body: unknown; auth: string | null }[] = [];
  const api = new ApiClient({ baseUrl: 'http://localhost:19401', token: 'session', fetchImpl: (async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('Authorization') });
    return new Response('{}', { status: 200 });
  }) as typeof fetch });
  await api.legal();
  await api.legalDocument('privacy');
  await api.register({ username: 'account', password: 'password1', agreed_legal_version: '2026-10-21' });
  await api.recover({ username: 'account', recovery_code: 'abcd-1234-ef56', new_password: 'password2' });
  await api.regenerateRecoveryCode('password2');
  await api.changePassword({ current_password: 'password2', new_password: 'password3' });
  assert.deepEqual(calls, [
    { path: '/api/legal', method: 'GET', body: undefined, auth: null },
    { path: '/api/legal/privacy', method: 'GET', body: undefined, auth: null },
    { path: '/api/auth/register', method: 'POST', body: { username: 'account', password: 'password1', agreed_legal_version: '2026-10-21' }, auth: null },
    { path: '/api/auth/recover', method: 'POST', body: { username: 'account', recovery_code: 'abcd-1234-ef56', new_password: 'password2' }, auth: null },
    { path: '/api/me/recovery-code', method: 'POST', body: { password: 'password2' }, auth: 'Bearer session' },
    { path: '/api/me/password', method: 'POST', body: { current_password: 'password2', new_password: 'password3' }, auth: 'Bearer session' },
  ]);
});
