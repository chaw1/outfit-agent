import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('design/tokens.json', root), 'utf8'));
const output = new URL('src/theme.ts', root);
const quote = value => `'${value.replaceAll("'", "\\'")}'`;

function lookup(path) {
  const value = path.split('.').reduce((node, key) => node?.[key], source);
  if (!value || !('$value' in value)) throw new Error(`未知 token：${path}`);
  return value;
}

function valueOf(token, trail = []) {
  if (!token.$description) throw new Error('每个 token 都必须有 $description');
  const value = token.$value;
  const alias = typeof value === 'string' && value.match(/^\{(.+)\}$/)?.[1];
  if (alias) {
    if (trail.includes(alias)) throw new Error(`循环引用：${alias}`);
    const target = lookup(alias);
    if (target.$type !== token.$type) throw new Error(`引用类型不匹配：${alias}`);
    return valueOf(target, [...trail, alias]);
  }
  switch (token.$type) {
    case 'color': {
      const format = token.$extensions?.['cn.yixu']?.format;
      const validChannel = channel => Number.isFinite(channel) && channel >= 0 && channel <= 1;
      if (value.colorSpace !== 'srgb' || !Array.isArray(value.components) || value.components.length !== 3 || !value.components.every(validChannel) || !validChannel(value.alpha ?? 1)) throw new Error('颜色必须使用有效 sRGB 分量和透明度（0–1）');
      const components = value.components.map(component => Math.round(component * 255));
      if (format === 'hex') {
        const bytes = value.alpha === 1 ? components : [...components, Math.round((value.alpha ?? 1) * 255)];
        return quote(`#${bytes.map(component => component.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
      }
      return quote(`rgba(${components.join(',')},${value.alpha ?? 1})`);
    }
    case 'dimension':
    case 'duration':
      if (!Number.isFinite(value.value) || value.unit !== (token.$type === 'dimension' ? 'px' : 'ms') || (token.$type === 'duration' && value.value < 0)) throw new Error('无效单位或数值');
      return String(value.value);
    case 'fontFamily':
      return token.$extensions?.['cn.yixu']?.platform === 'ios' ? `Platform.OS === 'ios' ? ${quote(value)} : undefined` : quote(value);
    case 'fontWeight': return quote(String(value));
    case 'number':
      if (!Number.isFinite(value)) throw new Error('无效数字');
      return String(value);
    default: throw new Error(`不支持的 token 类型：${token.$type}`);
  }
}

function group(node, depth = 0) {
  const indent = '  '.repeat(depth + 1);
  return `{\n${Object.entries(node).filter(([key]) => !key.startsWith('$')).map(([key, value]) => `${indent}${key}: ${'$value' in value ? valueOf(value) : group(value, depth + 1)},`).join('\n')}\n${'  '.repeat(depth)}}`;
}

function validate(node) {
  if ('$value' in node) { valueOf(node); return; }
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith('$')) validate(child);
  }
}
validate(source);

const generated = `// 由 tokens.json 生成，勿手改。运行 npm run tokens 更新。\nimport { Platform, type TextStyle } from 'react-native';\n\n` + [
  ['colors', source.color.paper], ['studio', source.color.studio], ['space', source.space],
  ['radius', source.radius], ['type', source.type], ['motion', source.motion], ['layout', source.layout],
].map(([name, node]) => `export const ${name} = ${group(node)} ${name === 'type' ? 'satisfies Record<string, TextStyle>' : 'as const'};\n`).join('\n');

if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== generated) {
    console.error('theme.ts 与 tokens.json 不一致，请运行 npm run tokens。');
    process.exitCode = 1;
  } else console.log('Token 生成结果一致。');
} else {
  writeFileSync(output, generated);
  console.log(`已生成 ${fileURLToPath(output)}`);
}
