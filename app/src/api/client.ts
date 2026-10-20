import { parseStreamEvent, SSEParser } from './sse';
import type {
  Asset, AssetKind, AuthResponse, CreateProjectInput, DoneData, ErrorData, HealthResponse,
  Job, LoginInput, Message, Project, ProjectState, RegisterInput, SendMessageInput, StreamEvent, User,
} from './types';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface NativeUploadFile { uri: string; name: string; type: string }

/** The common XMLHttpRequest subset available in browsers and Expo Go. */
export interface StreamXHR {
  readyState: number;
  status: number;
  responseText: string;
  timeout: number;
  onreadystatechange: (() => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body: string): void;
  abort(): void;
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | null | (() => string | null);
  onUnauthorized?: () => void | Promise<void>;
  fetchImpl?: typeof fetch;
  xhrFactory?: () => StreamXHR;
  streamTimeoutMs?: number;
}

export interface SendMessageOptions {
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error('已取消本次请求。');
  error.name = 'AbortError';
  return error;
}

function responseError(text: string, status: number): ApiError {
  let details: Partial<ErrorData> = {};
  try {
    const parsed = JSON.parse(text) as { error?: Partial<ErrorData> };
    if (parsed && typeof parsed.error === 'object' && parsed.error) details = parsed.error;
  } catch { /* A proxy may return HTML; keep the user-facing error readable. */ }
  const fallback = status === 401 ? '登录已过期，请重新登录。' : `请求失败（${status}），请稍后重试。`;
  return new ApiError(typeof details.code === 'string' ? details.code : `HTTP_${status}`,
    typeof details.message === 'string' ? details.message : fallback, status);
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    const base = options.baseUrl.trim().replace(/\/+$/, '');
    this.baseUrl = base.endsWith('/api') ? base : `${base}/api`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private token(): string | null {
    return typeof this.options.token === 'function' ? this.options.token() : this.options.token ?? null;
  }

  private unauthorized(requestToken: string | null): void {
    if (requestToken !== this.token()) return;
    try {
      const result = this.options.onUnauthorized?.();
      if (result) void result.catch(() => undefined);
    } catch { /* A navigation callback must not hide the original authentication error. */ }
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    const token = this.token();
    if (authenticated && token) headers.set('Authorization', `Bearer ${token}`);
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers }); }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ApiError('NETWORK_ERROR', '连接不到服务器，请检查网络和服务器地址。');
    }
    if (response.status === 401 && authenticated) this.unauthorized(token);
    let body: string;
    try { body = await response.text(); }
    catch { throw new ApiError('NETWORK_ERROR', '回复接收中断，请检查网络后重试。'); }
    if (!response.ok) {
      throw responseError(body, response.status);
    }
    if (!body) return undefined as T;
    try { return JSON.parse(body) as T; }
    catch { throw new ApiError('INVALID_RESPONSE', '服务器返回了无法读取的数据，请稍后重试。', response.status); }
  }

  register(input: RegisterInput): Promise<AuthResponse> {
    return this.request('/auth/register', { method: 'POST', body: JSON.stringify(input) }, false);
  }

  login(input: LoginInput): Promise<AuthResponse> {
    return this.request('/auth/login', { method: 'POST', body: JSON.stringify(input) }, false);
  }

  me(): Promise<User> { return this.request('/me'); }

  uploadAsset(file: File | NativeUploadFile, kind: AssetKind): Promise<Asset> {
    const body = new FormData();
    // React Native's FormData accepts this URI descriptor through the same append API.
    if ('uri' in file) body.append('file', file as unknown as Blob);
    else body.append('file', file, file.name);
    body.append('kind', kind);
    return this.request('/assets', { method: 'POST', body });
  }

  projects(): Promise<Project[]> { return this.request('/projects'); }
  createProject(input: CreateProjectInput): Promise<Project> {
    return this.request('/projects', { method: 'POST', body: JSON.stringify(input) });
  }
  project(id: string): Promise<Project> { return this.request(`/projects/${encodeURIComponent(id)}`); }
  state(id: string): Promise<ProjectState> { return this.request(`/projects/${encodeURIComponent(id)}/state`); }
  messages(id: string): Promise<Message[]> { return this.request(`/projects/${encodeURIComponent(id)}/messages`); }
  deleteProject(id: string): Promise<void> {
    return this.request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  job(id: string): Promise<Job> { return this.request(`/jobs/${encodeURIComponent(id)}`); }
  health(): Promise<HealthResponse> { return this.request('/health'); }

  /** One POST only: a failed stream must never silently replay a billable action. */
  sendMessage(projectId: string, input: SendMessageInput, options: SendMessageOptions): Promise<DoneData> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const requestToken = this.token();
    return new Promise<DoneData>((resolve, reject) => {
      const xhr = this.options.xhrFactory?.() ?? new XMLHttpRequest() as unknown as StreamXHR;
      let offset = 0;
      let settled = false;
      const stop = (): void => { try { xhr.abort(); } catch { /* A completed native transport may already be disposed. */ } };
      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', cancel);
        xhr.onreadystatechange = null;
        xhr.onload = null;
        xhr.onerror = null;
        xhr.ontimeout = null;
        xhr.onabort = null;
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        stop();
        reject(error);
      };
      const cancel = (): void => fail(abortError());
      const parser = new SSEParser((raw) => {
        if (settled) return;
        const event = parseStreamEvent(raw);
        if (!event) return;
        options.onEvent(event);
        if (event.type === 'error') {
          if (event.data.code === 'UNAUTHORIZED' || event.data.code === 'TOKEN_EXPIRED') this.unauthorized(requestToken);
          fail(new ApiError(event.data.code, event.data.message));
        } else if (event.type === 'done') {
          settled = true;
          cleanup();
          resolve(event.data);
          stop();
        }
      });
      const read = (final: boolean): void => {
        if (settled) return;
        if (xhr.status < 200 || xhr.status >= 300) {
          if (final) {
            if (xhr.status === 401) this.unauthorized(requestToken);
            fail(xhr.status === 0
              ? new ApiError('NETWORK_ERROR', '连接中断，请检查网络后重试。')
              : responseError(xhr.responseText, xhr.status));
          }
          return;
        }
        try {
          const text = xhr.responseText;
          if (text.length < offset) throw new ApiError('INVALID_STREAM', '消息连接异常，请重新加载对话。');
          const chunk = text.slice(offset);
          offset = text.length;
          parser.push(chunk);
          if (final && !settled) {
            parser.finish();
            if (!settled) fail(new ApiError('STREAM_INTERRUPTED', '回复连接已中断，已收到的内容已保留。请刷新项目查看最新结果。'));
          }
        } catch (error) { fail(error); }
      };
      xhr.onreadystatechange = () => { if (xhr.readyState >= 3) read(xhr.readyState === 4); };
      xhr.onload = () => read(true);
      xhr.onerror = () => fail(new ApiError('NETWORK_ERROR', '连接中断，请检查网络后重试。'));
      xhr.ontimeout = () => fail(new ApiError('TIMEOUT', '等待回复超时，请刷新项目查看最新结果。'));
      xhr.onabort = cancel;
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        xhr.open('POST', `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/messages`, true);
        xhr.timeout = this.options.streamTimeoutMs ?? 120_000;
        xhr.setRequestHeader('Accept', 'text/event-stream');
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (requestToken) xhr.setRequestHeader('Authorization', `Bearer ${requestToken}`);
        xhr.send(JSON.stringify(input));
      } catch (error) { fail(error); }
    });
  }
}
