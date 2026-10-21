import * as LegacyFileSystem from 'expo-file-system/legacy';
import { NativeUploadTimeout, type NativeUploader } from './upload';

// iOS / Android 用系统的 NSURLSession / OkHttp 直接按文件 URI 走 multipart 上传，
// 不经过 JS 侧 FormData 的文件描述符（真机上该通道对相册文件不稳定）。
// 和 fetch 通道一样受上传限时约束：到点就取消底层任务，让页面恢复可操作。
export const nativeUpload: NativeUploader = async (url, fileUri, { mimeType, headers, fields, timeoutMs }) => {
  const task = LegacyFileSystem.createUploadTask(url, fileUri, {
    httpMethod: 'POST', uploadType: LegacyFileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file', mimeType, parameters: fields, headers,
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void task.cancelAsync().catch(() => undefined); }, timeoutMs);
  try {
    let result: LegacyFileSystem.FileSystemUploadResult | undefined | null;
    try { result = await task.uploadAsync(); }
    catch (error) { if (timedOut) throw new NativeUploadTimeout(); throw error; }
    if (timedOut || !result) throw new NativeUploadTimeout();
    return { status: result.status, body: result.body };
  } finally { clearTimeout(timer); }
};
