import { readFileSync, writeFileSync } from 'node:fs';

const sourceUrl = new URL('../design/tokens.json', import.meta.url);
const documentUrl = new URL('../../docs/设计系统.md', import.meta.url);
const startMarker = '<!-- tokens:start -->';
const endMarker = '<!-- tokens:end -->';

function escapeCell(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
    .replace(/\r\n|\r|\n/g, '<br>');
}

function figmaVariable(tokenPath) {
  const parts = tokenPath[0] === 'color' ? tokenPath.slice(1) : tokenPath;
  return parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('/');
}

function formatValue(token, type, tokenPath) {
  const value = token.$value;
  if (typeof value === 'string' && /^\{[^{}]+\}$/.test(value)) return value;
  const fail = message => { throw new Error(`${tokenPath}: ${message}`); };
  if (type === 'color') {
    const alpha = value?.alpha ?? 1;
    const validChannel = channel => Number.isFinite(channel) && channel >= 0 && channel <= 1;
    if (value?.colorSpace !== 'srgb' || !Array.isArray(value.components) || value.components.length !== 3 || !value.components.every(validChannel) || !validChannel(alpha)) fail('颜色必须使用有效 sRGB 分量与透明度（0–1）');
    const format = token.$extensions?.['cn.yixu']?.format ?? 'rgba';
    const components = value.components.map(component => Math.round(component * 255));
    if (format === 'hex') {
      const bytes = alpha === 1 ? components : [...components, Math.round(alpha * 255)];
      return `#${bytes.map(component => component.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }
    if (format === 'rgba') return `rgba(${components.join(',')},${alpha})`;
    fail(`不支持的颜色输出格式 ${format}`);
  }
  if (type === 'dimension' || type === 'duration') {
    const unit = type === 'dimension' ? 'px' : 'ms';
    if (!Number.isFinite(value?.value) || value.unit !== unit || (type === 'duration' && value.value < 0)) fail(`需要有限数值与 ${unit} 单位`);
    return `${value.value}${value.unit}`;
  }
  if (type === 'fontFamily') {
    const families = Array.isArray(value) ? value.join(', ') : String(value);
    return token.$extensions?.['cn.yixu']?.platform === 'ios' ? `${families}（仅 iOS；其他平台使用系统字体）` : families;
  }
  if (type === 'number' && !Number.isFinite(value)) fail('需要有限数值');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function tokenRows(source) {
  const rows = [];
  function visit(node, tokenPath = [], inheritedType) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`无效 token 分组：${tokenPath.join('.')}`);
    const type = node.$type ?? inheritedType;
    if (Object.hasOwn(node, '$value')) {
      const name = tokenPath.join('.');
      if (typeof type !== 'string' || !type) throw new Error(`${name}: 缺少 $type`);
      if (typeof node.$description !== 'string' || !node.$description.trim()) throw new Error(`${name}: 缺少 $description`);
      rows.push([name, figmaVariable(tokenPath), type, formatValue(node, type, name), node.$description]);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith('$')) visit(child, [...tokenPath, key], type);
    }
  }
  visit(source);
  return rows;
}

function generateDocument(source, document) {
  const starts = [...document.matchAll(new RegExp(startMarker, 'g'))];
  const ends = [...document.matchAll(new RegExp(endMarker, 'g'))];
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw new Error('设计系统.md 必须包含唯一且按顺序排列的 tokens:start / tokens:end marker');
  const table = [
    '| Token 路径 | Figma Variable | $type | 值 | 说明 |',
    '|---|---|---|---|---|',
    ...tokenRows(source).map(row => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
  const contentStart = starts[0].index + startMarker.length;
  const contentEnd = ends[0].index;
  return `${document.slice(0, contentStart)}\n\n${table}\n\n${document.slice(contentEnd)}`;
}

try {
  if (process.argv.slice(2).some(argument => argument !== '--check')) throw new Error('仅支持 --check 参数');
  const source = JSON.parse(readFileSync(sourceUrl, 'utf8'));
  const document = readFileSync(documentUrl, 'utf8');
  const generated = generateDocument(source, document);
  if (process.argv.includes('--check')) {
    if (document !== generated) {
      console.error('设计系统 token 表与 tokens.json 不一致，请运行 npm run tokens。');
      process.exitCode = 1;
    } else console.log('Token 文档生成结果一致。');
  } else if (document !== generated) {
    writeFileSync(documentUrl, generated);
    console.log(`已更新设计系统 token 表（${tokenRows(source).length} 个 token）。`);
  } else console.log('设计系统 token 表已是最新。');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
