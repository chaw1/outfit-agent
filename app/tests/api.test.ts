import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiError } from '../src/api/client';
import type { StreamXHR } from '../src/api/client';
import type { Card, Message, OutfitImage, SendMessageInput, StreamEvent } from '../src/api/types';

class FakeXHR implements StreamXHR {
  readyState = 0;
  status = 200;
  responseText = '';
  timeout = 0;
  onreadystatechange: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  headers: Record<string, string> = {};
  method = '';
  url = '';
  body = '';
  sends = 0;
  aborted = false;
  open(method: string, url: string): void { this.method = method; this.url = url; this.readyState = 1; }
  setRequestHeader(name: string, value: string): void { this.headers[name] = value; }
  send(body: string): void { this.body = body; this.sends += 1; }
  abort(): void { this.aborted = true; this.onabort?.(); }
  chunk(value: string): void { this.responseText += value; this.readyState = 3; this.onreadystatechange?.(); }
  finish(): void { this.readyState = 4; this.onreadystatechange?.(); this.onload?.(); }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('REST centralizes exact paths, bodies, dynamic auth and base URL normalization', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let token: string | null = 'first';
  const client = new ApiClient({
    baseUrl: 'http://localhost:19080/api/', token: () => token,
    fetchImpl: (async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return json({}); }) as typeof fetch,
  });
  await client.register({ username: 'gary', password: 'password1', nickname: '嘉伟' });
  await client.login({ username: 'gary', password: 'password1' });
  await client.me();
  token = 'second';
  await client.projects();
  const input = { title: '秋日合作', brand: '品牌', brief: '自然一点', garment_asset_ids: ['a1'] };
  await client.createProject(input);
  await client.project('p/1');
  await client.state('p/1');
  await client.messages('p/1');
  await client.job('j/1');
  await client.health();
  assert.deepEqual(calls.map((call) => call.url), [
    '/auth/register', '/auth/login', '/me', '/projects', '/projects',
    '/projects/p%2F1', '/projects/p%2F1/state', '/projects/p%2F1/messages', '/jobs/j%2F1', '/health',
  ].map((path) => `http://localhost:19080/api${path}`));
  assert.equal(new Headers(calls[0]?.init.headers).has('Authorization'), false);
  assert.equal(new Headers(calls[2]?.init.headers).get('Authorization'), 'Bearer first');
  assert.equal(new Headers(calls[3]?.init.headers).get('Authorization'), 'Bearer second');
  assert.equal(new Headers(calls[9]?.init.headers).get('Authorization'), 'Bearer second');
  assert.deepEqual(JSON.parse(String(calls[4]?.init.body)), input);
});

test('asset upload sends multipart without manually setting its boundary', async () => {
  let request: RequestInit | undefined;
  const client = new ApiClient({ baseUrl: 'http://localhost:19080', fetchImpl: (async (_url, init) => {
    request = init; return json({ id: 'asset1' });
  }) as typeof fetch });
  await client.uploadAsset(new File(['image'], 'shirt.jpg', { type: 'image/jpeg' }), 'garment');
  if (!request || !(request.body instanceof FormData)) throw new Error('上传请求缺少 FormData');
  assert.equal(request.body.get('kind'), 'garment');
  assert.equal((request.body.get('file') as File).name, 'shirt.jpg');
  assert.equal(new Headers(request.headers).has('Content-Type'), false);
});

test('REST 401 signs out once; invalid login does not disturb the session callback', async () => {
  let unauthorized = 0;
  const client = new ApiClient({
    baseUrl: 'http://localhost:19080', onUnauthorized: () => { unauthorized += 1; },
    fetchImpl: (async () => json({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } }, 401)) as typeof fetch,
  });
  await assert.rejects(client.me(), (error: unknown) => error instanceof ApiError && error.status === 401 && error.message === '登录已过期');
  await assert.rejects(client.login({ username: 'gary', password: 'bad-password' }), ApiError);
  assert.equal(unauthorized, 1);
});

test('REST reports offline and malformed responses as actionable errors', async () => {
  const offline = new ApiClient({ baseUrl: 'http://localhost:19080', fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch });
  await assert.rejects(offline.projects(), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_ERROR');
  const invalid = new ApiClient({ baseUrl: 'http://localhost:19080', fetchImpl: (async () => new Response('<html>')) as typeof fetch });
  await assert.rejects(invalid.projects(), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});

test('default fetch retains the global receiver required by browser native functions', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = function (this: typeof globalThis) {
    assert.equal(this, globalThis);
    return Promise.resolve(json({ id: 'user1' }));
  } as typeof fetch;
  try {
    const client = new ApiClient({ baseUrl: 'http://localhost:19080' });
    assert.equal((await client.me()).id, 'user1');
  } finally { globalThis.fetch = original; }
});

test('stream sends a single authenticated POST and delivers each incremental event once', async () => {
  const xhr = new FakeXHR();
  const events: StreamEvent[] = [];
  const client = new ApiClient({ baseUrl: 'http://localhost:19080', token: 'test-token', xhrFactory: () => xhr });
  const promise = client.sendMessage('p/1', { action: { type: 'confirm_script' } }, { onEvent: (event) => events.push(event) });
  xhr.chunk('event: token\r\ndata: {"delta":"你');
  assert.equal(events.length, 0);
  xhr.chunk('好"}\r\n\r\nevent: card\ndata: {"id":"c1","type":"images","items":[]}\n\n');
  xhr.chunk('event: job\ndata: {"id":"j1","status":"queued"}\n\n');
  xhr.chunk('event: done\ndata: {"message_id":"m1"}\n\n');
  assert.deepEqual(await promise, { message_id: 'm1' });
  assert.deepEqual(events.map((event) => event.type), ['token', 'card', 'job', 'done']);
  assert.equal(xhr.headers.Authorization, 'Bearer test-token');
  assert.equal(xhr.headers.Accept, 'text/event-stream');
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, 'http://localhost:19080/api/projects/p%2F1/messages');
  assert.deepEqual(JSON.parse(xhr.body), { action: { type: 'confirm_script' } });
  assert.equal(xhr.sends, 1);
  assert.equal(xhr.aborted, true);
});

test('stream detects unexpected EOF and never retries the action', async () => {
  const xhr = new FakeXHR();
  const client = new ApiClient({ baseUrl: 'http://localhost:19080', xhrFactory: () => xhr });
  const promise = client.sendMessage('p1', { text: '再松弛一点' }, { onEvent: () => undefined });
  xhr.chunk('event: token\ndata: {"delta":"收到"}\n\n');
  xhr.finish();
  await assert.rejects(promise, (error: unknown) => error instanceof ApiError && error.code === 'STREAM_INTERRUPTED');
  assert.equal(xhr.sends, 1);
});

test('local edits preserve precise selections, refs, and failed checks through streaming and restored history', async () => {
  const region = { x: 0, y: 0.123456789, w: 1, h: 0.25 };
  const mask = { brush: 0.0375, strokes: [[{ x: 0, y: 0 }, { x: 0.333333333, y: 0.625 }], [{ x: 1, y: 1 }]] };
  const inputs: SendMessageInput[] = [
    { text: '只改框出的袖口', action: { type: 'edit_image', image_id: 'image-original', instruction: '袖口放下来', region }, refs: ['image-original'] },
    { action: { type: 'edit_image', image_id: 'image-original', instruction: '去掉吊牌', mask_strokes: mask }, refs: ['image-original', 'image-previous'] },
  ];
  for (const input of inputs) {
    const snapshot = structuredClone(input);
    const xhr = new FakeXHR();
    const events: StreamEvent[] = [];
    const queued: Card = { id: 'project-images', type: 'images', items: [{ id: 'image-edited', shot_id: 'shot-1', status: 'queued', version: 2, parent_id: 'image-original', instruction: input.action?.type === 'edit_image' ? input.action.instruction : '', region }] };
    const completedItems: OutfitImage[] = queued.items.map(image => ({ ...image, status: 'succeeded', url: '/edited.png', edit_check: { passed: false, reason: '袖口仍卷着，请再试一次。' } }));
    const completed: Card = { ...queued, items: completedItems };
    const history: Message[] = [{ id: 'user-ref', role: 'user', text: input.text ?? '', cards: [], action: input.action, refs: input.refs, created_at: '2026-10-20T16:00:00Z' }];
    const client = new ApiClient({ baseUrl: 'http://localhost:19080', xhrFactory: () => xhr, fetchImpl: (async () => json(history)) as typeof fetch });
    const sending = client.sendMessage('p1', input, { onEvent: event => events.push(event) });
    assert.deepEqual(JSON.parse(xhr.body), snapshot);
    const frames = `event: card\ndata: ${JSON.stringify(queued)}\n\nevent: card\ndata: ${JSON.stringify(completed)}\n\nevent: done\ndata: {"message_id":"assistant-done"}\n\n`;
    for (let offset = 0; offset < frames.length; offset += 11) xhr.chunk(frames.slice(offset, offset + 11));
    assert.deepEqual(await sending, { message_id: 'assistant-done' });
    assert.deepEqual(events.filter(event => event.type === 'card').map(event => event.data), [queued, completed]);
    assert.deepEqual(await client.messages('p1'), history);
    assert.deepEqual(input, snapshot, 'sending must preserve the selection for an explicit retry');
    assert.equal(xhr.sends, 1);
  }
});

test('stream cancellation aborts the transport; already-aborted requests do not send', async () => {
  const xhr = new FakeXHR();
  const controller = new AbortController();
  const client = new ApiClient({ baseUrl: 'http://localhost:19080', xhrFactory: () => xhr });
  const promise = client.sendMessage('p1', { text: '你好' }, { onEvent: () => undefined, signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(xhr.aborted, true);
  await assert.rejects(client.sendMessage('p1', { text: '你好' }, { onEvent: () => undefined, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(xhr.sends, 1);
});

test('stream 401, server errors, invalid frames and timeout reject without replay', async () => {
  for (const scenario of ['unauthorized', 'error', 'invalid', 'timeout', 'network'] as const) {
    const xhr = new FakeXHR();
    let unauthorized = 0;
    const client = new ApiClient({ baseUrl: 'http://localhost:19080', xhrFactory: () => xhr, onUnauthorized: () => { unauthorized += 1; } });
    const promise = client.sendMessage('p1', { text: '你好' }, { onEvent: () => undefined });
    if (scenario === 'unauthorized') {
      xhr.status = 401;
      xhr.responseText = JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '请登录' } });
      xhr.finish();
    } else if (scenario === 'error') xhr.chunk('event: error\ndata: {"code":"BUSY","message":"请稍后"}\n\n');
    else if (scenario === 'invalid') xhr.chunk('event: token\ndata: broken\n\n');
    else if (scenario === 'timeout') xhr.ontimeout?.();
    else xhr.onerror?.();
    await assert.rejects(promise);
    assert.equal(unauthorized, scenario === 'unauthorized' ? 1 : 0);
    assert.equal(xhr.sends, 1);
  }
});

test('late REST and streaming 401 responses cannot expire a replacement token', async () => {
  let token: string | null = 'old-token';
  let unauthorized = 0;
  let respond: (response: Response) => void = () => { throw new Error('请求尚未开始'); };
  const xhr = new FakeXHR();
  const client = new ApiClient({
    baseUrl: 'http://localhost:19080', token: () => token,
    onUnauthorized: () => { unauthorized += 1; }, xhrFactory: () => xhr,
    fetchImpl: (() => new Promise<Response>(resolve => { respond = resolve; })) as typeof fetch,
  });
  const rest = client.me();
  const streaming = client.sendMessage('p1', { text: '你好' }, { onEvent: () => undefined });
  token = 'new-token';
  respond(json({ error: { code: 'UNAUTHORIZED', message: '旧登录过期' } }, 401));
  xhr.status = 401; xhr.finish();
  await assert.rejects(rest, ApiError);
  await assert.rejects(streaming, ApiError);
  assert.equal(unauthorized, 0);
});

test('disposed transport throwing on abort cannot leave completion or cancellation pending', { timeout: 1000 }, async () => {
  const xhr = new FakeXHR();
  xhr.abort = () => { throw new Error('already disposed'); };
  const client = new ApiClient({ baseUrl: 'http://localhost:19080', xhrFactory: () => xhr });
  const done = client.sendMessage('p1', { text: '你好' }, { onEvent: () => undefined });
  xhr.chunk('event: done\ndata: {"message_id":"m1"}\n\n');
  assert.deepEqual(await done, { message_id: 'm1' });
  const controller = new AbortController();
  const cancelled = client.sendMessage('p1', { text: '取消' }, { onEvent: () => undefined, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});
