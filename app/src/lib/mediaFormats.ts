export function mediaFilename(id: string, extension: string): string {
  return `outfit-${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}.${extension}`;
}

export function mediaExtension(bytes: Uint8Array, kind: 'image' | 'video'): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (kind === 'video') {
    if (ascii(4, 8) === 'ftyp' && !['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(ascii(8, 12))) return ascii(8, 12) === 'qt  ' ? 'mov' : 'mp4';
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) return 'webm';
    throw new Error('下载的文件不是可保存的视频，请刷新笔记后重试。');
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['avif', 'avis'].includes(brand)) return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'tif';
  throw new Error('下载的文件不是可保存的图片，请刷新笔记后重试。');
}
