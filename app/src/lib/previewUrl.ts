/** 服务端媒体链接按需带 `w=` 出 JPEG 预览；列表与缩略图用它，查看器大图用原链接。 */
export type PreviewWidth = 360 | 720 | 1080;

export function previewUrl<T extends string | null | undefined>(url: T, width: PreviewWidth = 720): T {
  if (!url || !/\/media\/[^/?]+\?/.test(url) || /[?&]w=\d+/.test(url)) return url;
  return `${url}&w=${width}` as T;
}
