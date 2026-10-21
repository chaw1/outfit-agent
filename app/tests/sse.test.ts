import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStreamEvent, SSEParser, SSEProtocolError } from '../src/api/sse';
import type { RawSSEEvent } from '../src/api/sse';

test('SSE accepts every possible chunk boundary, CRLF, comments and multiline data', () => {
  const source = '\uFEFF: keepalive\r\nid: 17\r\nevent: token\r\ndata: {"delta":\r\ndata: "你好"}\r\n\r\nevent: done\r\ndata: {"message_id":"m1"}\r\n\r\n';
  for (let split = 0; split <= source.length; split += 1) {
    const events: RawSSEEvent[] = [];
    const parser = new SSEParser((event) => events.push(event));
    parser.push(source.slice(0, split));
    parser.push(source.slice(split));
    parser.finish();
    assert.deepEqual(events.map(parseStreamEvent), [
      { type: 'token', data: { delta: '你好' } },
      { type: 'done', data: { message_id: 'm1' } },
    ]);
    assert.equal(events[1]?.id, '17');
  }
});

test('SSE handles one-character chunks, bare CR and an event at EOF', () => {
  const events: RawSSEEvent[] = [];
  const parser = new SSEParser((event) => events.push(event));
  const source = 'event: token\rdata: {"delta":"a"}\r\revent: done\ndata:{"message_id":"last"}';
  for (const character of source) parser.push(character);
  parser.finish();
  parser.finish();
  assert.deepEqual(events.map(parseStreamEvent), [
    { type: 'token', data: { delta: 'a' } },
    { type: 'done', data: { message_id: 'last' } },
  ]);
});

test('SSE decodes card, job and error events and ignores extensions', () => {
  assert.deepEqual(parseStreamEvent({ event: 'card', data: '{"id":"c1","type":"images","items":[]}' }), {
    type: 'card', data: { id: 'c1', type: 'images', items: [] },
  });
  assert.deepEqual(parseStreamEvent({ event: 'job', data: '{"id":"j1","status":"running"}' }), {
    type: 'job', data: { id: 'j1', status: 'running' },
  });
  assert.deepEqual(parseStreamEvent({ event: 'error', data: '{"code":"BUSY","message":"请稍后"}' }), {
    type: 'error', data: { code: 'BUSY', message: '请稍后' },
  });
  assert.equal(parseStreamEvent({ event: 'heartbeat', data: 'not JSON' }), null);
});

test('malformed known events fail explicitly instead of silently losing a reply', () => {
  for (const raw of [
    { event: 'token', data: '{broken' },
    { event: 'token', data: '{"delta":4}' },
    { event: 'done', data: '{}' },
    { event: 'job', data: '{"id":"j1","status":"unknown"}' },
    { event: 'card', data: '{"id":"c1","type":"unknown"}' },
    { event: 'error', data: 'null' },
  ]) assert.throws(() => parseStreamEvent(raw), SSEProtocolError);
});

test('an event without data is ignored and a colon only removes one leading space', () => {
  const events: RawSSEEvent[] = [];
  const parser = new SSEParser((event) => events.push(event));
  parser.push('event: unused\n\n:comment\ndata:  retained\n\n');
  assert.deepEqual(events, [{ event: 'message', data: ' retained', id: undefined }]);
});

test('trace survives fragmented SSE before done, including steps and image references', () => {
  const trace = { tool: 'write_script', model: 'local-text', duration_ms: 4800, cost_cny: 0.01, refs: ['image-1'], steps: [{ label: '看图 2 件', duration_ms: 3100 }, { label: '写脚本', duration_ms: 1700 }] };
  const source = `event: trace\ndata: ${JSON.stringify(trace)}\n\nevent: done\ndata: {"message_id":"m1"}\n\n`;
  const events: unknown[] = [];
  const parser = new SSEParser(event => events.push(parseStreamEvent(event)));
  for (const character of source) parser.push(character);
  parser.finish();
  assert.deepEqual(events, [{ type: 'trace', data: trace }, { type: 'done', data: { message_id: 'm1' } }]);
  for (const broken of [{ ...trace, duration_ms: -1 }, { ...trace, refs: [2] }, { ...trace, steps: [{ label: '步骤', duration_ms: '1' }] }, { tool: 'chat' }]) {
    assert.throws(() => parseStreamEvent({ event: 'trace', data: JSON.stringify(broken) }), SSEProtocolError);
  }
});

test('reference cards and consistency metadata survive fragmented SSE unchanged', () => {
  const cards = [
    { id: 'references-1', type: 'references', items: [{ asset_id: 'reference-1', url: '/reference.jpg', style_tags: ['自然光', '街角构图'] }] },
    { id: 'images-1', type: 'images', items: [{ id: 'image-2', shot_id: 'shot-2', status: 'succeeded', version: 1, anchor_id: 'image-1', fidelity: { score: 92, diffs: [], auto_fixed: false, person_score: 0, anchor_score: 95 } }] },
  ];
  const events: unknown[] = [];
  const parser = new SSEParser(raw => events.push(parseStreamEvent(raw)));
  for (const character of cards.map(card => `event: card\ndata: ${JSON.stringify(card)}\n\n`).join('')) parser.push(character);
  parser.finish();
  assert.deepEqual(events, cards.map(data => ({ type: 'card', data })));
});

test('edit reuse metadata is retained on both task and done responses without changing legacy done', () => {
  assert.deepEqual(parseStreamEvent({ event: 'done', data: '{"message_id":"m1","reused":true}' }), { type: 'done', data: { message_id: 'm1', reused: true } });
  assert.deepEqual(parseStreamEvent({ event: 'done', data: '{"message_id":"m2","reused":false}' }), { type: 'done', data: { message_id: 'm2', reused: false } });
  const job = { id: 'old-task', status: 'succeeded', reused: true };
  assert.deepEqual(parseStreamEvent({ event: 'job', data: JSON.stringify(job) }), { type: 'job', data: job });
});
