import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

interface Account { token: string; user: { id: string; username: string }; recovery_code?: string }
interface StoredUser { passwordHash: string; recovery_code_hash: string; password_updated_at?: string; token_version?: number }

async function setup() {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const root = path.resolve(import.meta.dirname, '../mock-server/.data/tests');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'account-password-'));
  let instant = Date.parse('2026-10-21T10:15:00.123Z');
  const server = await createMockServer({ dataDir, clock: () => instant });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (route: string, body: Record<string, unknown>, token?: string) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const login = (password = 'original-password') => post('/api/auth/login', { username: 'password-owner', password });
  const me = (token: string) => fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  const user = async () => (JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { users: StoredUser[] }).users[0];
  return {
    post, login, me, user,
    advance: () => { instant += 1000; },
    now: () => new Date(instant).toISOString(),
    async cleanup() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('password changes return a new session, revoke all old sessions, and preserve the recovery code', async () => {
  const app = await setup();
  try {
    const registered = await app.post('/api/auth/register', { username: 'password-owner', password: 'original-password' });
    const first = await registered.json() as Account;
    assert.ok(first.recovery_code);
    const before = await app.user();
    app.advance();
    const second = await (await app.login()).json() as Account;
    assert.notEqual(second.token, first.token);
    const response = await app.post('/api/me/password', { current_password: 'original-password', new_password: 'changed-password' }, second.token);
    assert.equal(response.status, 200);
    const current = await response.json() as Account;
    assert.deepEqual(current.user, second.user);
    assert.equal('recovery_code' in current, false);
    assert.notEqual(current.token, second.token);
    assert.equal((await app.me(first.token)).status, 401);
    assert.equal((await app.me(second.token)).status, 401);
    assert.equal((await app.me(current.token)).status, 200);
    assert.equal((await app.login()).status, 401);
    assert.equal((await app.login('changed-password')).status, 200);
    const after = await app.user();
    assert.notEqual(after.passwordHash, before.passwordHash);
    assert.equal(after.password_updated_at, app.now());
    assert.equal(after.token_version, 1);
    assert.equal(after.recovery_code_hash, before.recovery_code_hash);
    const recovered = await app.post('/api/auth/recover', { username: 'password-owner', recovery_code: first.recovery_code, new_password: 'recovered-password' });
    assert.equal(recovered.status, 200);
    assert.equal((await app.me(current.token)).status, 401);
    assert.equal((await app.login('recovered-password')).status, 200);
  } finally { await app.cleanup(); }
});

test('wrong current password and invalid new passwords leave credentials and sessions unchanged', async () => {
  const app = await setup();
  try {
    const registered = await app.post('/api/auth/register', { username: 'password-owner', password: 'original-password' });
    const account = await registered.json() as Account;
    const before = await app.user();
    const invalid = [
      { current_password: 'wrong-password', new_password: 'changed-password' },
      { current_password: 'original-password', new_password: 'short' },
      { current_password: 'original-password', new_password: 12345678 },
      { new_password: 'changed-password' },
    ];
    for (const body of invalid) {
      const response = await app.post('/api/me/password', body, account.token);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'INVALID_PASSWORD');
      assert.deepEqual(await app.user(), before);
      assert.equal((await app.me(account.token)).status, 200);
    }
    assert.equal((await app.post('/api/me/password', { current_password: 'original-password', new_password: 'changed-password' })).status, 401);
    assert.equal((await app.login()).status, 200);
    assert.equal((await app.login('changed-password')).status, 401);
    const recovered = await app.post('/api/auth/recover', { username: 'password-owner', recovery_code: account.recovery_code, new_password: 'recovered-password' });
    assert.equal(recovered.status, 200);
  } finally { await app.cleanup(); }
});
