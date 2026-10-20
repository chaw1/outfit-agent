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
