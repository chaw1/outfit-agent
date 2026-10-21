import * as LegacyFileSystem from 'expo-file-system/legacy';
import type { NativeUploader } from './upload';

// iOS / Android 用系统的 NSURLSession / OkHttp 直接按文件 URI 走 multipart 上传，
// 不经过 JS 侧 FormData 的文件描述符（真机上该通道对相册文件不稳定）。
export const nativeUpload: NativeUploader = async (url, fileUri, { mimeType, headers, fields }) => {
  const result = await LegacyFileSystem.uploadAsync(url, fileUri, {
    httpMethod: 'POST', uploadType: LegacyFileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file', mimeType, parameters: fields, headers,
  });
  return { status: result.status, body: result.body };
};
