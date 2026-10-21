import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const directories = process.argv.slice(2);
if (!directories.length) throw new Error('请提供正式导出目录，例如 dist/ios dist/android dist/web。');
const markers = ['__design', 'YIXU_DS_GALLERY_ONLY'];
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) files.push(file);
  }
}
for (const directory of directories) {
  if (!statSync(directory).isDirectory()) throw new Error(`不是导出目录：${directory}`);
  const previous = files.length;
  visit(directory);
  if (files.length === previous) throw new Error(`导出目录为空：${directory}`);
}
const violations = files.filter(file => {
  const content = readFileSync(file);
  return markers.some(marker => content.includes(Buffer.from(marker)));
});
if (violations.length) {
  console.error(`正式产物包含画廊标记：\n${violations.join('\n')}`);
  process.exitCode = 1;
} else console.log(`已检查 ${directories.join(' / ')} 的 ${files.length} 个文件（含 Hermes 二进制），无画廊路由或页面标记。`);
