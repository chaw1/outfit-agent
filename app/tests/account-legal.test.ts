import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

interface LegalDocument {
  kind: string;
  title: string;
  version: string;
  markdown: string;
}

test('legal documents are public, versioned, readable, and reject unknown kinds', async () => {
  const { createMockServer } = await import('../mock-server/index.mjs');
  const root = path.resolve(import.meta.dirname, '../mock-server/.data/tests');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'account-legal-'));
  const server = await createMockServer({ dataDir });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/legal`);
    assert.equal(response.status, 200);
    const listing = await response.json() as Omit<LegalDocument, 'markdown'>[];
    assert.deepEqual(listing, [
      { kind: 'terms', title: '用户协议', version: '2026-10-21' },
      { kind: 'privacy', title: '隐私政策', version: '2026-10-21' },
      { kind: 'disclaimer', title: 'AI 内容免责声明', version: '2026-10-21' },
    ]);
    for (const entry of listing) {
      const detail = await fetch(`${base}/api/legal/${entry.kind}`, { headers: { Authorization: 'Bearer expired-token' } });
      assert.equal(detail.status, 200);
      const { markdown, ...metadata } = await detail.json() as LegalDocument;
      assert.deepEqual(metadata, entry);
      assert.match(markdown, /^# 衣序（演示版）/);
      assert.match(markdown, /97000945@qq\.com/);
      assert.ok(markdown.length > 500, 'each document contains readable demo terms');
    }
    const missing = await fetch(`${base}/api/legal/unknown`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: 'NOT_FOUND', message: '没有找到这份协议' } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
