import { INSUFFICIENT_POINTS_TEXT } from '../lib/transparency';
import type { AssetPage, LibraryKind, SavedModel } from '../lib/assets';
import type { GarmentTagPage } from '../lib/garmentTags';
import { nativeUpload } from '../lib/upload';
import { parseStreamEvent, SSEParser } from './sse';
import type {
  Asset, AssetKind, AuthResponse, AutoQuote, ChangePasswordInput, CreateProjectInput, DoneData, ErrorData, HealthResponse,
  Job, LegalDocument, LegalKind, LegalSummary, LoginInput, Message, Project, ProjectState, RecoverInput, RecoveryAuthResponse, RegisterInput, SendMessageInput, StreamEvent, UpdateMeInput, User,
} from './types';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(code === 'BUDGET_EXCEEDED' ? INSUFFICIENT_POINTS_TEXT : message);
    this.name = 'ApiError';
  }
}

export interface NativeUploadFile { uri: string; name: string; type: string }

export const REST_TIMEOUT_MS = { read: 20_000, write: 60_000, upload: 120_000 } as const;
export type RestRequestKind = keyof typeof REST_TIMEOUT_MS;

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
  restTimeoutMs?: Partial<Record<RestRequestKind, number>>;
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

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true, kind: RestRequestKind = /^(GET|HEAD)$/i.test(init.method ?? 'GET') ? 'read' : 'write'): Promise<T> {
    if (init.signal?.aborted) throw abortError();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    const token = this.token();
    if (authenticated && token) headers.set('Authorization', `Bearer ${token}`);
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    init.signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timeoutError = new ApiError('TIMEOUT', kind === 'read' ? '读取超时，请重试。'
      : kind === 'upload' ? '图片上传超时，请检查网络后重新选择。' : '提交等待超时，请先刷新查看结果，避免重复提交。');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(timeoutError); controller.abort(); }, this.options.restTimeoutMs?.[kind] ?? REST_TIMEOUT_MS[kind]);
    });
    try {
      let response: Response;
      try { response = await Promise.race([this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal }), deadline]); }
      catch (error) {
        if (timedOut) throw timeoutError;
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new ApiError('NETWORK_ERROR', '连接不到服务器，请检查网络和服务器地址。');
      }
      if (response.status === 401 && authenticated) this.unauthorized(token);
      let body: string;
      try { body = await Promise.race([response.text(), deadline]); }
      catch (error) {
        if (timedOut) throw timeoutError;
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new ApiError('NETWORK_ERROR', '回复接收中断，请检查网络后重试。');
      }
      if (!response.ok) throw responseError(body, response.status);
      if (!body) return undefined as T;
      try { return JSON.parse(body) as T; }
      catch { throw new ApiError('INVALID_RESPONSE', '服务器返回了无法读取的数据，请稍后重试。', response.status); }
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', cancel);
    }
  }

  register(input: RegisterInput): Promise<AuthResponse> {
    return this.request('/auth/register', { method: 'POST', body: JSON.stringify(input) }, false);
  }

  login(input: LoginInput): Promise<AuthResponse> {
    return this.request('/auth/login', { method: 'POST', body: JSON.stringify(input) }, false);
  }

  legal(): Promise<LegalSummary[]> { return this.request('/legal', {}, false); }
  legalDocument(kind: LegalKind): Promise<LegalDocument> { return this.request(`/legal/${kind}`, {}, false); }

  recover(input: RecoverInput): Promise<RecoveryAuthResponse> {
    return this.request('/auth/recover', { method: 'POST', body: JSON.stringify(input) }, false);
  }
  changePassword(input: ChangePasswordInput): Promise<AuthResponse> {
    return this.request('/me/password', { method: 'POST', body: JSON.stringify(input) });
  }
  deleteAccount(password: string): Promise<void> {
    return this.request('/me', { method: 'DELETE', body: JSON.stringify({ password }) });
  }
  regenerateRecoveryCode(password: string): Promise<{ recovery_code: string }> {
    return this.request('/me/recovery-code', { method: 'POST', body: JSON.stringify({ password }) });
  }

  me(): Promise<User> { return this.request('/me'); }
  myAssets(kind: LibraryKind, limit = 30, offset = 0, tag?: string | null): Promise<AssetPage> {
    return this.request(`/me/assets?kind=${kind}&limit=${limit}&offset=${offset}${kind === 'garment' && tag ? `&tag=${encodeURIComponent(tag)}` : ''}`);
  }
  myAssetTags(): Promise<GarmentTagPage> { return this.request('/me/assets/tags?kind=garment'); }
  saveModelFromImage(image_id: string, name?: string): Promise<SavedModel> {
    return this.request('/me/models/from-image', { method: 'POST', body: JSON.stringify({ image_id, ...(name ? { name } : {}) }) });
  }
  deleteMyAsset(id: string): Promise<void> {
    return this.request(`/me/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  patchMe(input: UpdateMeInput): Promise<User> {
    return this.request('/me', { method: 'PATCH', body: JSON.stringify(input) });
  }

  async uploadAsset(file: File | NativeUploadFile, kind: AssetKind): Promise<Asset> {
    if ('uri' in file && nativeUpload) {
      const token = this.token();
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      let result: { status: number; body: string };
      const timeoutMs = this.options.restTimeoutMs?.upload ?? REST_TIMEOUT_MS.upload;
      try { result = await nativeUpload(`${this.baseUrl}/assets`, file.uri, { mimeType: file.type, headers, fields: { kind }, timeoutMs }); }
      catch (error) {
        if (error instanceof Error && error.name === 'NativeUploadTimeout') throw new ApiError('TIMEOUT', '图片上传超时，请检查网络后重新选择。');
        throw new ApiError('NETWORK_ERROR', `图片上传失败，请检查网络后重试。${error instanceof Error && error.message ? `（${error.message}）` : ''}`);
      }
      if (result.status === 401) this.unauthorized(token);
      if (result.status < 200 || result.status >= 300) throw responseError(result.body, result.status);
      try { return JSON.parse(result.body) as Asset; }
      catch { throw new ApiError('INVALID_RESPONSE', '服务器返回了无法读取的数据，请稍后重试。', result.status); }
    }
    const body = new FormData();
    // React Native's FormData accepts this URI descriptor through the same append API.
    if ('uri' in file) body.append('file', file as unknown as Blob);
    else body.append('file', file, file.name);
    body.append('kind', kind);
    return this.request('/assets', { method: 'POST', body }, true, 'upload');
  }

  autoQuote(): Promise<AutoQuote> { return this.request('/quotes/auto'); }
  editQuote(): Promise<AutoQuote> { return this.request('/quotes/edit'); }
  projects(): Promise<Project[]> { return this.request('/projects'); }
  createProject(input: CreateProjectInput): Promise<Project> {
    return this.request('/projects', { method: 'POST', body: JSON.stringify(input) });
  }
  patchProject(id: string, input: { title?: string; pinned?: boolean }): Promise<Project> {
    return this.request(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
  }
  project(id: string): Promise<Project> { return this.request(`/projects/${encodeURIComponent(id)}`); }
  setProjectMode(id: string, input: { mode: 'guided' }): Promise<ProjectState> {
    return this.request(`/projects/${encodeURIComponent(id)}/mode`, { method: 'POST', body: JSON.stringify(input) });
  }
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
