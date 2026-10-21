/** Web 与 Node 测试：没有原生上传通道，客户端回退到 fetch + FormData。 */
export interface NativeUploadResult { status: number; body: string }
export interface NativeUploadOptions { mimeType: string; headers: Record<string, string>; fields: Record<string, string>; timeoutMs: number }
export type NativeUploader = (url: string, fileUri: string, options: NativeUploadOptions) => Promise<NativeUploadResult>;
/** 原生上传在限定时间内没有结束：底层任务已取消，调用方按超时处理。 */
export class NativeUploadTimeout extends Error {
  constructor() { super('upload timeout'); this.name = 'NativeUploadTimeout'; }
}
export const nativeUpload: NativeUploader | null = null;
