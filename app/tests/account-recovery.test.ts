import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

interface Account { token: string; user: { id: string; username: string }; recovery_code: string }
interface StoredUser { username: string; recovery_code_hash: string; password_updated_at?: string; token_version?: number }

async function temporaryData() {
  const root = path.resolve(import.meta.dirname, '../mock-server/.data/tests');
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'account-recovery-'));
}
async function start(dataDir: string, clock: () => number) {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const server = await createMockServer({ dataDir, clock });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
const post = (base: string, route: string, body: Record<string, unknown>, token?: string) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
async function register(base: string, username: string) {
  const response = await post(base, '/api/auth/register', { username, password: 'original-password', agreed_legal_version: '2026-10-21' });
  assert.equal(response.status, 200);
  const account = await response.json() as Account;
  assert.match(account.recovery_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return account;
}
const recover = (base: string, username: string, recovery_code: string, new_password = 'changed-password') => post(base, '/api/auth/recover', { username, recovery_code, new_password });
const me = (base: string, token: string) => fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
const stored = async (dataDir: string) => JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { users: StoredUser[]; rate_limits: Record<string, unknown> };
const recoveryError = { error: { code: 'RECOVERY_FAILED', message: '找回失败，请检查用户名、恢复码和新密码，或稍后再试' } };

test('recovery rotates the hashed code and invalidates all older tokens in the same second, including after restart', async () => {
  const dataDir = await temporaryData();
  const instant = Date.parse('2026-10-21T10:12:00.456Z');
  let session = await start(dataDir, () => instant);
  try {
    const original = await register(session.base, 'recover-owner');
    const login = await post(session.base, '/api/auth/login', { username: 'recover-owner', password: 'original-password' });
    const loginBody = await login.json() as Account;
    assert.equal('recovery_code' in loginBody, false);
    const dbBefore = await stored(dataDir);
    assert.match(dbBefore.users[0].recovery_code_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(dbBefore).includes(original.recovery_code), false);
    assert.equal(JSON.stringify(dbBefore).includes(original.recovery_code.replaceAll('-', '')), false);
    const response = await recover(session.base, ' RECOVER-OWNER ', original.recovery_code.toLowerCase().replaceAll('-', ''));
    assert.equal(response.status, 200);
    const next = await response.json() as Account;
    assert.notEqual(next.token, original.token);
    assert.notEqual(next.recovery_code, original.recovery_code);
    assert.equal((await me(session.base, original.token)).status, 401);
    assert.equal((await me(session.base, loginBody.token)).status, 401);
    assert.equal((await me(session.base, next.token)).status, 200);
    assert.equal((await post(session.base, '/api/auth/login', { username: 'recover-owner', password: 'original-password' })).status, 401);
    assert.equal((await post(session.base, '/api/auth/login', { username: 'recover-owner', password: 'changed-password' })).status, 200);
    assert.equal((await recover(session.base, 'recover-owner', original.recovery_code)).status, 400);
    const dbAfter = await stored(dataDir);
    assert.equal(dbAfter.users[0].password_updated_at, new Date(instant).toISOString());
    assert.equal(dbAfter.users[0].token_version, 1);
    assert.notEqual(dbAfter.users[0].recovery_code_hash, dbBefore.users[0].recovery_code_hash);
    assert.equal(JSON.stringify(dbAfter).includes(next.recovery_code), false);
    await close(session.server);
    session = await start(dataDir, () => instant);
    assert.equal((await me(session.base, next.token)).status, 200);
    assert.equal((await me(session.base, original.token)).status, 401);
    assert.equal((await recover(session.base, 'recover-owner', next.recovery_code, 'restarted-password')).status, 200);
    assert.equal((await me(session.base, next.token)).status, 401);
  } finally {
    await close(session.server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('recovery failures are uniform and per-username rate limits persist until the window expires', async () => {
  const dataDir = await temporaryData();
  let instant = Date.parse('2026-10-21T10:13:00.000Z');
  let session = await start(dataDir, () => instant);
  try {
    const account = await register(session.base, 'rate-owner');
    const other = await register(session.base, 'other-owner');
    const unknown = await recover(session.base, 'unknown-owner', account.recovery_code);
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), recoveryError);
    const requests = [
      () => recover(session.base, 'rate-owner', 'AAAA-BBBB-CCCC'),
      () => recover(session.base, 'RATE-OWNER', ''),
      () => recover(session.base, 'rate-owner', account.recovery_code, 'short'),
      () => post(session.base, '/api/auth/recover', { username: 'rate-owner', recovery_code: 123, new_password: 'changed-password' }),
      () => recover(session.base, ' rate-owner ', 'DDDD-EEEE-FFFF'),
    ];
    for (const request of requests) {
      const response = await request();
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), recoveryError);
    }
    const blocked = await recover(session.base, 'RATE-OWNER', account.recovery_code);
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), recoveryError);
    assert.equal((await recover(session.base, 'other-owner', other.recovery_code)).status, 200);
    await close(session.server);
    session = await start(dataDir, () => instant);
    assert.equal((await recover(session.base, 'rate-owner', account.recovery_code)).status, 429);
    instant += 15 * 60 * 1000 + 1;
    assert.equal((await recover(session.base, 'rate-owner', account.recovery_code)).status, 200);
  } finally {
    await close(session.server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('regenerating a recovery code requires the password and revokes only the old recovery code', async () => {
  const dataDir = await temporaryData();
  const session = await start(dataDir, () => Date.parse('2026-10-21T10:14:00.000Z'));
  try {
    const account = await register(session.base, 'rotate-owner');
    const before = (await stored(dataDir)).users[0].recovery_code_hash;
    const wrong = await post(session.base, '/api/me/recovery-code', { password: 'wrong-password' }, account.token);
    assert.equal(wrong.status, 400);
    assert.equal((await stored(dataDir)).users[0].recovery_code_hash, before);
    assert.equal((await post(session.base, '/api/me/recovery-code', { password: 'original-password' })).status, 401);
    const response = await post(session.base, '/api/me/recovery-code', { password: 'original-password' }, account.token);
    assert.equal(response.status, 200);
    const next = await response.json() as { recovery_code: string };
    assert.match(next.recovery_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.notEqual(next.recovery_code, account.recovery_code);
    assert.notEqual((await stored(dataDir)).users[0].recovery_code_hash, before);
    assert.equal((await me(session.base, account.token)).status, 200);
    assert.equal((await recover(session.base, 'rotate-owner', account.recovery_code)).status, 400);
    const body = await (await me(session.base, account.token)).json() as Record<string, unknown>;
    assert.equal('recovery_code' in body, false);
    assert.equal('recovery_code_hash' in body, false);
    const raw = await readFile(path.join(dataDir, 'db.json'), 'utf8');
    assert.equal(raw.includes(next.recovery_code), false);
    assert.equal(raw.includes(next.recovery_code.replaceAll('-', '')), false);
    const attempts = await Promise.all([
      recover(session.base, 'rotate-owner', next.recovery_code),
      recover(session.base, 'rotate-owner', next.recovery_code),
    ]);
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 400]);
  } finally {
    await close(session.server);
    await rm(dataDir, { recursive: true, force: true });
  }
});
