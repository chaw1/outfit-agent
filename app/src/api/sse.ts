import type { StreamEvent } from './types';

export interface RawSSEEvent { event: string; data: string; id?: string }

/** Incremental SSE framing; the transport may split a line or even CRLF anywhere. */
export class SSEParser {
  private buffer = '';
  private eventName = '';
  private data: string[] = [];
  private lastId: string | undefined;
  private firstChunk = true;

  constructor(private readonly onEvent: (event: RawSSEEvent) => void) {}

  push(chunk: string): void {
    if (this.firstChunk && chunk.length > 0) {
      chunk = chunk.replace(/^\uFEFF/, '');
      this.firstChunk = false;
    }
    this.buffer += chunk;
    this.readLines(false);
  }

  finish(): void {
    this.readLines(true);
    if (this.buffer.length > 0) this.readLine(this.buffer);
    this.buffer = '';
    this.dispatch();
  }

  private readLines(final: boolean): void {
    for (;;) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0) return;
      if (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1) return;
      const length = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + length);
      this.readLine(line);
    }
  }

  private readLine(line: string): void {
    if (line === '') { this.dispatch(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    if (field === 'data') this.data.push(value);
    if (field === 'id' && !value.includes('\0')) this.lastId = value;
  }

  private dispatch(): void {
    const data = this.data;
    const event = this.eventName || 'message';
    this.data = [];
    this.eventName = '';
    if (data.length > 0) this.onEvent({ event, data: data.join('\n'), id: this.lastId });
  }
}

export function createSSEParser(onEvent: (event: RawSSEEvent) => void): SSEParser {
  return new SSEParser(onEvent);
}

export class SSEProtocolError extends Error {
  readonly code = 'INVALID_STREAM';
  constructor(message = '服务器返回了无法读取的消息，请稍后重试。') {
    super(message);
    this.name = 'SSEProtocolError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Unknown event names are ignored, so server heartbeats/extensions remain harmless. */
export function parseStreamEvent(raw: RawSSEEvent): StreamEvent | null {
  if (!['token', 'card', 'job', 'trace', 'done', 'error'].includes(raw.event)) return null;
  let data: unknown;
  try { data = JSON.parse(raw.data) as unknown; } catch { throw new SSEProtocolError(); }
  if (!record(data)) throw new SSEProtocolError();
  switch (raw.event) {
    case 'trace':
      if (typeof data.tool !== 'string' || typeof data.model !== 'string' ||
          typeof data.duration_ms !== 'number' || !Number.isFinite(data.duration_ms) || data.duration_ms < 0 ||
          typeof data.cost_cny !== 'number' || !Number.isFinite(data.cost_cny) || data.cost_cny < 0 ||
          !Array.isArray(data.refs) || !data.refs.every(ref => typeof ref === 'string') ||
          (data.reference_images !== undefined && (!Array.isArray(data.reference_images) || !data.reference_images.every(image => record(image) && typeof image.id === 'string' && typeof image.url === 'string' && ['模特', '衣服', '参考图', '封面锚点'].includes(String(image.role))))) ||
          !Array.isArray(data.steps) || !data.steps.every(step => record(step) && typeof step.label === 'string' &&
            typeof step.duration_ms === 'number' && Number.isFinite(step.duration_ms) && step.duration_ms >= 0)) {
        throw new SSEProtocolError();
      }
      return { type: 'trace', data: data as unknown as Extract<StreamEvent, { type: 'trace' }>['data'] };
    case 'token':
      if (typeof data.delta !== 'string') throw new SSEProtocolError();
      return { type: 'token', data: { delta: data.delta } };
    case 'done':
      if (typeof data.message_id !== 'string') throw new SSEProtocolError();
      return { type: 'done', data: { message_id: data.message_id, ...(typeof data.reused === 'boolean' ? { reused: data.reused } : {}) } };
    case 'error':
      if (typeof data.code !== 'string' || typeof data.message !== 'string') throw new SSEProtocolError();
      return { type: 'error', data: { code: data.code, message: data.message } };
    case 'card':
      if (typeof data.id !== 'string' || typeof data.type !== 'string' ||
          !['garments', 'references', 'directions', 'script', 'images', 'note', 'video'].includes(data.type)) {
        throw new SSEProtocolError();
      }
      return { type: 'card', data: data as unknown as Extract<StreamEvent, { type: 'card' }>['data'] };
    case 'job':
      if (typeof data.id !== 'string' ||
          !['queued', 'running', 'succeeded', 'failed'].includes(String(data.status))) {
        throw new SSEProtocolError();
      }
      return { type: 'job', data: data as unknown as Extract<StreamEvent, { type: 'job' }>['data'] };
    default: return null;
  }
}
