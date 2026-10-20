import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const screenshots = path.join(root, 'screenshots/polish');
const output = path.join(root, 'verification/polish');
await mkdir(output, { recursive: true });
const files = (await readdir(screenshots)).filter(file => file.endsWith('.png')).sort();
const manifest = [];
for (const file of files) {
  const bytes = await readFile(path.join(screenshots, file));
  const { width, height } = await sharp(bytes).metadata();
  if (width !== 390 || height !== 844) throw new Error(`${file}: expected 390×844, got ${width}×${height}`);
  manifest.push({ file, width, height, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(path.join(output, 'screenshots.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: manifest.length, viewport: '390×844', screenshots: manifest }, null, 2) + '\n');
for (let start = 0; start < files.length; start += 16) {
  const batch = files.slice(start, start + 16);
  const tiles = [];
  for (const [index, file] of batch.entries()) {
    const left = (index % 4) * 215;
    const top = Math.floor(index / 4) * 460;
    tiles.push({ input: await sharp(path.join(screenshots, file)).resize(195, 422).toBuffer(), left: left + 10, top: top + 28 });
    const label = file.replace('.png', '').replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    tiles.push({ input: Buffer.from(`<svg width="215" height="24"><text x="10" y="17" fill="#252522" font-family="Arial" font-size="10">${label}</text></svg>`), left, top });
  }
  await sharp({ create: { width: 860, height: Math.ceil(batch.length / 4) * 460, channels: 3, background: '#FCFAF7' } }).composite(tiles).jpeg({ quality: 86 }).toFile(path.join(output, `contact-sheet-${start / 16 + 1}.jpg`));
}
console.log(`Verified ${manifest.length} screenshots at 390×844; manifest and contact sheets: verification/polish/`);

const theme = await readFile(path.join(root, 'src/theme.ts'), 'utf8');
const palette = Object.fromEntries([...theme.matchAll(/(\w+): '(#[0-9A-Fa-f]{6})'/g)].map(match => [match[1], match[2]]));
function luminance(hex) {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
const pairs = [['ink', 'surface'], ['muted', 'paper'], ['muted', 'imagePlaceholder'], ['redText', 'blush'], ['green', 'successSoft'], ['danger', 'blush'], ['white', 'action'], ['white', 'viewerSurface'], ['viewerMuted', 'viewerCanvas']];
const contrast = pairs.map(([foreground, background]) => {
  const light = luminance(palette[foreground]), dark = luminance(palette[background]);
  const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
  if (ratio < 4.5) throw new Error(`Text contrast below 4.5:1: ${foreground}/${background} ${ratio}`);
  return { foreground, foregroundHex: palette[foreground], background, backgroundHex: palette[background], ratio: Number(ratio.toFixed(3)), minimum: 4.5 };
});
await writeFile(path.join(output, 'contrast.json'), JSON.stringify({ checkedAt: new Date().toISOString(), scope: '主要正文、辅助文字、标签和操作按钮颜色对；图片水印和禁用态不在本检查内。', pairs: contrast }, null, 2) + '\n');
