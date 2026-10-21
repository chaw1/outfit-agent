import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

async function withTokens(check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outfit-tokens-'));
  try {
    for (const folder of ['scripts', 'design', 'src']) await mkdir(path.join(directory, folder));
    for (const file of ['scripts/build-tokens.mjs', 'design/tokens.json', 'src/theme.ts']) {
      await copyFile(new URL(`../${file}`, import.meta.url), path.join(directory, file));
    }
    await check(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function build(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, ['scripts/build-tokens.mjs', ...args], { cwd: directory, encoding: 'utf8' });
}

test('token generation is deterministic and check catches a hand-edited theme', async () => {
  await withTokens(async directory => {
    const theme = path.join(directory, 'src/theme.ts');
    const before = await readFile(theme, 'utf8');
    assert.equal(build(directory).status, 0);
    assert.equal(await readFile(theme, 'utf8'), before);
    assert.equal(build(directory, '--check').status, 0);
    await writeFile(theme, `${before}\n// drift\n`);
    assert.equal(build(directory, '--check').status, 1);
  });
});

test('DTCG color components drive aliases and generated values', async () => {
  await withTokens(async directory => {
    const file = path.join(directory, 'design/tokens.json');
    const tokens = JSON.parse(await readFile(file, 'utf8'));
    tokens.color.brand.primary.$value.components = [0, 0, 0];
    await writeFile(file, JSON.stringify(tokens));
    assert.equal(build(directory).status, 0);
    assert.match(await readFile(path.join(directory, 'src/theme.ts'), 'utf8'), /action: '#000000'/);
  });
});

test('token generation rejects circular aliases and missing descriptions', async () => {
  await withTokens(async directory => {
    const file = path.join(directory, 'design/tokens.json');
    const tokens = JSON.parse(await readFile(file, 'utf8'));
    tokens.color.brand.primary.$value = '{color.paper.action}';
    await writeFile(file, JSON.stringify(tokens));
    assert.match(build(directory).stderr, /循环引用/);
    tokens.color.brand.primary.$value = '{color.paper.red}';
    delete tokens.color.paper.red.$description;
    await writeFile(file, JSON.stringify(tokens));
    assert.match(build(directory).stderr, /description/);
  });
});

for (const [label, mutate] of [
  ['dimension unit', (tokens: Record<string, Record<string, { $value: { unit: string } }>>) => { tokens.space.xs.$value.unit = 'ms'; }],
  ['duration unit', (tokens: Record<string, Record<string, { $value: { unit: string } }>>) => { tokens.motion.fast.$value.unit = 'px'; }],
] as const) {
  test(`token generation rejects invalid ${label}`, async () => {
    await withTokens(async directory => {
      const file = path.join(directory, 'design/tokens.json');
      const tokens = JSON.parse(await readFile(file, 'utf8'));
      mutate(tokens);
      await writeFile(file, JSON.stringify(tokens));
      assert.equal(build(directory).status, 1);
    });
  });
}

test('token validation covers unreferenced values, color bounds and alias types', async () => {
  await withTokens(async directory => {
    const file = path.join(directory, 'design/tokens.json');
    const original = await readFile(file, 'utf8');
    for (const mutation of ['unused', 'color', 'alpha', 'alias']) {
      const tokens = JSON.parse(original);
      if (mutation === 'unused') tokens.color.brand.extra = { $type: 'color', $value: '{color.paper.red}' };
      if (mutation === 'color') tokens.color.paper.red.$value.components[0] = 2;
      if (mutation === 'alpha') tokens.color.paper.red.$value.alpha = -1;
      if (mutation === 'alias') tokens.color.paper.red.$value = '{space.xs}';
      await writeFile(file, JSON.stringify(tokens));
      assert.equal(build(directory).status, 1, mutation);
    }
  });
});
