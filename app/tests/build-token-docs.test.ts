import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptSource = new URL('../scripts/build-token-docs.mjs', import.meta.url);

const tokens = {
  color: {
    brand: {
      primary: {
        $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0.5], alpha: 1 },
        $description: '主要操作', $extensions: { 'cn.yixu': { format: 'hex' } },
      },
      soft: {
        $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0.5], alpha: 0.5 },
        $description: '透明色', $extensions: { 'cn.yixu': { format: 'hex' } },
      },
    },
    studio: {
      overlay: {
        $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.72 },
        $description: '遮罩', $extensions: { 'cn.yixu': { format: 'rgba' } },
      },
      accent: { $type: 'color', $value: '{color.brand.primary}', $description: '复用品牌操作' },
    },
  },
  space: { sm: { $type: 'dimension', $value: { value: 8, unit: 'px' }, $description: '内容间距' } },
  motion: { fast: { $type: 'duration', $value: { value: 160, unit: 'ms' }, $description: '快速反馈' } },
  type: {
    display: {
      fontFamily: { $type: 'fontFamily', $value: 'Songti SC', $description: '展示字体', $extensions: { 'cn.yixu': { platform: 'ios' } } },
      fontSize: { $type: 'dimension', $value: { value: 34, unit: 'px' }, $description: '展示字号' },
      fontWeight: { $type: 'fontWeight', $value: 300, $description: '展示字重' },
    },
  },
  layout: { thumbnailRatio: { $type: 'number', $value: 0.75, $description: '缩略图比例' } },
};
const originalDocument = '# 衣序 DS\n\n前文保持原样。\n\n<!-- tokens:start -->\nold table\n<!-- tokens:end -->\n\n后文保持原样。\n';

async function withFixture(check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outfit-token-docs-'));
  try {
    for (const folder of ['app/scripts', 'app/design', 'app/src', 'docs']) await mkdir(path.join(directory, folder), { recursive: true });
    await copyFile(scriptSource, path.join(directory, 'app/scripts/build-token-docs.mjs'));
    await writeFile(path.join(directory, 'app/design/tokens.json'), JSON.stringify(tokens));
    await writeFile(path.join(directory, 'app/src/theme.ts'), '// theme sentinel\n');
    await writeFile(path.join(directory, 'docs/设计系统.md'), originalDocument);
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function build(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, ['app/scripts/build-token-docs.mjs', ...args], { cwd: directory, encoding: 'utf8' });
}

function documentPath(directory: string) { return path.join(directory, 'docs/设计系统.md'); }
function sourcePath(directory: string) { return path.join(directory, 'app/design/tokens.json'); }

test('token docs generate values, Figma mappings and iOS font notes without changing source or theme', async () => {
  await withFixture(async directory => {
    const sourceBefore = await readFile(sourcePath(directory), 'utf8');
    assert.equal(build(directory).status, 0);
    const generated = await readFile(documentPath(directory), 'utf8');
    assert.match(generated, /\| color\.brand\.primary \| Brand\/Primary \| color \| #FF0080 \| 主要操作 \|/);
    assert.match(generated, /\| color\.brand\.soft \| Brand\/Soft \| color \| #FF008080 \|/);
    assert.match(generated, /\| color\.studio\.overlay \| Studio\/Overlay \| color \| rgba\(0,0,0,0\.72\) \|/);
    assert.match(generated, /\| space\.sm \| Space\/Sm \| dimension \| 8px \|/);
    assert.match(generated, /\| motion\.fast \| Motion\/Fast \| duration \| 160ms \|/);
    assert.match(generated, /Type\/Display\/FontSize \| dimension \| 34px/);
    assert.match(generated, /Songti SC（仅 iOS；其他平台使用系统字体）/);
    assert.match(generated, /Layout\/ThumbnailRatio \| number \| 0\.75/);
    assert.ok(generated.startsWith('# 衣序 DS\n\n前文保持原样。\n\n<!-- tokens:start -->\n\n'));
    assert.ok(generated.endsWith('<!-- tokens:end -->\n\n后文保持原样。\n'));
    assert.equal(await readFile(sourcePath(directory), 'utf8'), sourceBefore);
    assert.equal(await readFile(path.join(directory, 'app/src/theme.ts'), 'utf8'), '// theme sentinel\n');
  });
});

test('token docs generation is idempotent and a clean --check does not write', async () => {
  await withFixture(async directory => {
    assert.equal(build(directory).status, 0);
    const first = await readFile(documentPath(directory), 'utf8');
    assert.equal(build(directory).status, 0);
    assert.equal(await readFile(documentPath(directory), 'utf8'), first);
    assert.equal(build(directory, '--check').status, 0);
    assert.equal(await readFile(documentPath(directory), 'utf8'), first);
  });
});

test('--check reports both edited documentation and changed tokens while leaving the document untouched', async () => {
  await withFixture(async directory => {
    const stale = await readFile(documentPath(directory), 'utf8');
    const initial = build(directory, '--check');
    assert.equal(initial.status, 1);
    assert.match(initial.stderr, /不一致/);
    assert.equal(await readFile(documentPath(directory), 'utf8'), stale);
    assert.equal(build(directory).status, 0);
    const generated = await readFile(documentPath(directory), 'utf8');
    const changed = structuredClone(tokens);
    changed.space.sm.$value.value = 12;
    await writeFile(sourcePath(directory), JSON.stringify(changed));
    assert.equal(build(directory, '--check').status, 1);
    assert.equal(await readFile(documentPath(directory), 'utf8'), generated);
  });
});

test('aliases remain visible as source references instead of being resolved', async () => {
  await withFixture(async directory => {
    assert.equal(build(directory).status, 0);
    assert.match(await readFile(documentPath(directory), 'utf8'), /\| color\.studio\.accent \| Studio\/Accent \| color \| \{color\.brand\.primary\} \|/);
  });
});

test('pipe characters and all newline forms stay inside their Markdown table cells', async () => {
  await withFixture(async directory => {
    const changed = structuredClone(tokens);
    changed.space.sm.$description = '左 | 右\n第二行\r\n第三行\r第四行\\路径 <tag>';
    changed.type.display.fontFamily.$value = 'A | B\nC';
    await writeFile(sourcePath(directory), JSON.stringify(changed));
    assert.equal(build(directory).status, 0);
    const generated = await readFile(documentPath(directory), 'utf8');
    assert.ok(generated.includes('左 \\| 右<br>第二行<br>第三行<br>第四行\\\\路径 &lt;tag&gt;'));
    assert.ok(generated.includes('A \\| B<br>C（仅 iOS；其他平台使用系统字体）'));
    assert.equal(generated.split('\n').filter(line => line.startsWith('|')).length, 12);
  });
});

test('missing, duplicate or reversed markers fail without overwriting the document', async () => {
  await withFixture(async directory => {
    for (const broken of [
      '# missing markers\n',
      '<!-- tokens:start -->\n',
      '<!-- tokens:end -->\n',
      '<!-- tokens:end -->\n<!-- tokens:start -->\n',
      '<!-- tokens:start -->\n<!-- tokens:start -->\n<!-- tokens:end -->\n',
      '<!-- tokens:start -->\n<!-- tokens:end -->\n<!-- tokens:end -->\n',
    ]) {
      await writeFile(documentPath(directory), broken);
      const result = build(directory);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /marker/);
      assert.equal(await readFile(documentPath(directory), 'utf8'), broken);
    }
  });
});

test('invalid token values and missing descriptions fail before changing documentation', async () => {
  await withFixture(async directory => {
    for (const changed of [
      { color: { bad: { $type: 'color', $value: { colorSpace: 'srgb', components: [2, 0, 0] }, $description: 'bad' } } },
      { space: { bad: { $type: 'dimension', $value: { value: 8, unit: 'ms' }, $description: 'bad' } } },
      { space: { bad: { $type: 'dimension', $value: { value: 8, unit: 'px' } } } },
    ]) {
      await writeFile(sourcePath(directory), JSON.stringify(changed));
      assert.equal(build(directory).status, 1);
      assert.equal(await readFile(documentPath(directory), 'utf8'), originalDocument);
    }
  });
});
