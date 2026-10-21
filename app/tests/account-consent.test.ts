import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

interface StoredUser {
  username: string;
  legal_version: string;
  legal_agreed_at: string | null;
}

test('registration persists legal consent and keeps old clients compatible', async () => {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const root = path.resolve(import.meta.dirname, '../mock-server/.data/tests');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'account-consent-'));
  const instant = Date.parse('2026-10-21T10:11:00.000Z');
  const server = await createMockServer({ dataDir, clock: () => instant });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (route: string, body: Record<string, unknown>) => fetch(`${base}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const register = (username: string, extra: Record<string, unknown> = {}) => post('/api/auth/register', { username, password: 'demo-password', ...extra });
    assert.equal((await register('with-consent', { agreed_legal_version: '2026-10-21' })).status, 200);
    assert.equal((await register('old-client')).status, 200);
    assert.equal((await register('empty-consent', { agreed_legal_version: '' })).status, 200);
    assert.equal((await register('bad-consent', { agreed_legal_version: 20261021 })).status, 400);
    assert.equal((await post('/api/auth/login', { username: 'old-client', password: 'demo-password', agreed_legal_version: '2026-10-21' })).status, 200);
    const db = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')) as { users: StoredUser[] };
    assert.equal(db.users.length, 3);
    assert.deepEqual(db.users.map(({ username, legal_version, legal_agreed_at }) => ({ username, legal_version, legal_agreed_at })), [
      { username: 'with-consent', legal_version: '2026-10-21', legal_agreed_at: new Date(instant).toISOString() },
      { username: 'old-client', legal_version: '', legal_agreed_at: null },
      { username: 'empty-consent', legal_version: '', legal_agreed_at: null },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
