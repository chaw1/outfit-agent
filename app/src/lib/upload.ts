/** Web 与 Node 测试：没有原生上传通道，客户端回退到 fetch + FormData。 */
export interface NativeUploadResult { status: number; body: string }
export type NativeUploader = (url: string, fileUri: string, options: { mimeType: string; headers: Record<string, string>; fields: Record<string, string> }) => Promise<NativeUploadResult>;
export const nativeUpload: NativeUploader | null = null;
