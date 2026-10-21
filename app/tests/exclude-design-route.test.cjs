'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const modulePaths = [process.env.APP_DIR, process.cwd(), path.join(process.cwd(), 'app')].filter(Boolean);
const { transformSync } = require(require.resolve('@babel/core', { paths: modulePaths }));
const plugin = require('../scripts/exclude-design-route.cjs');

const routerDir = path.join(process.cwd(), 'node_modules', 'expo-router');
const patterns = {
  '_ctx.js': /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)))\.[tj]sx?$).*\.[tj]sx?$/,
  '_ctx.web.js': /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+middleware)|(?:\+(html|native-intent))))\.[tj]sx?$).*(?:\.android|\.ios|\.native)?\.[tj]sx?$/,
  '_ctx.ios.js': /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)))\.[tj]sx?$).*(?:\.android|\.web)?\.[tj]sx?$/,
  '_ctx.android.js': /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)))\.[tj]sx?$).*(?:\.ios|\.web)?\.[tj]sx?$/,
};
const gallery = [
  './__design.tsx', './__design.ts', './__design.js', './__design.jsx',
  './__design.web.tsx', './__design.native.tsx', './__design.ios.tsx', './__design.android.tsx',
  './__design/index.tsx', './__design/deep/Card.tsx', './__design/+api.ts',
];
const otherRoutes = [
  './index.tsx', './_layout.tsx', './projects/[id].tsx', './projects/new.tsx',
  './__designer.tsx', './__designers/index.tsx', './nested/__design.tsx',
  './+html.js', './+html.tsx', './nested/+html.tsx',
  './+middleware.ts', './+native-intent.tsx', './generate+api.tsx', './nested/generate+api.ts',
  './index.web.tsx', './index.ios.tsx', './index.android.tsx', './index.native.tsx',
  './picture.png', './file.json', 'index.tsx', '/index.tsx',
];

function transform(pattern, { isDev = false, filename = path.join(routerDir, '_ctx.web.js'), caller = { name: 'metro', isDev }, code } = {}) {
  const result = transformSync(code ?? `export const ctx = require.context(process.env.EXPO_ROUTER_APP_ROOT, true, ${pattern.toString()}, process.env.EXPO_ROUTER_IMPORT_MODE);`, {
    filename,
    configFile: false,
    babelrc: false,
    ast: true,
    plugins: [plugin],
    ...(caller === null ? {} : { caller }),
  });
  const declaration = result.ast.program.body.find(node => node.type === 'ExportNamedDeclaration')?.declaration ?? result.ast.program.body.find(node => node.type === 'VariableDeclaration');
  const regex = declaration?.declarations[0].init?.arguments?.[2];
  return { code: result.code, ast: result.ast, regex: regex?.type === 'RegExpLiteral' ? new RegExp(regex.pattern, regex.flags) : undefined };
}

for (const [contextFile, original] of Object.entries(patterns)) {
  test(`${contextFile}: development keeps the exact original pattern`, () => {
    const { regex } = transform(original, { isDev: true, filename: path.join(routerDir, contextFile) });
    assert.equal(regex.source, original.source);
    assert.equal(regex.flags, original.flags);
    for (const route of [...gallery, ...otherRoutes]) assert.equal(regex.test(route), original.test(route), route);
    assert.equal(regex.test('./__design.tsx'), true);
    assert.equal(regex.test('./__design/index.tsx'), true);
  });

  test(`${contextFile}: production excludes only the requested gallery paths`, () => {
    const { regex } = transform(original, { filename: path.join(routerDir, contextFile) });
    for (const route of gallery) assert.equal(regex.test(route), false, route);
    for (const route of otherRoutes) assert.equal(regex.test(route), original.test(route), route);
    assert.equal(regex.flags, original.flags);
  });
}

test('HTML context and shared router modules are left unchanged', () => {
  for (const contextFile of ['_ctx-html.js', '_ctx-shared.js']) {
    const original = /\+html\.[tj]sx?$/;
    const { regex } = transform(original, { filename: path.join(routerDir, contextFile) });
    assert.equal(regex.source, original.source);
    assert.equal(regex.test('./+html.tsx'), true);
    assert.equal(regex.test('./nested/+html.tsx'), true);
  }
});

test('ordinary project files, similarly named packages, and other Expo Router files are untouched', () => {
  for (const filename of [
    path.join(process.cwd(), 'src', '_ctx.js'),
    path.join(process.cwd(), 'src', 'expo-router', '_ctx.js'),
    path.join(process.cwd(), 'node_modules', 'not-expo-router', '_ctx.js'),
    path.join(routerDir, 'build', 'app.js'),
    path.join(routerDir, '_ctx.d.ts'),
  ]) {
    const { regex } = transform(patterns['_ctx.js'], { filename });
    assert.equal(regex.source, patterns['_ctx.js'].source, filename);
  }
});

test('a missing caller or a caller without isDev also excludes the gallery', () => {
  for (const caller of [null, { name: 'metro' }, { name: 'metro', isDev: false }]) {
    const { regex } = transform(patterns['_ctx.js'], { caller });
    assert.equal(regex.test('./__design.tsx'), false);
    assert.equal(regex.test('./index.tsx'), true);
  }
});

test('keeps source captures, backreferences, regexp flags and unanchored filter matches', () => {
  for (const original of [/^(\.\/)(?!.*\+api)([a-z_-]+)\/\2\.[tj]sx?$/i, /index\.[tj]sx?$/u, /^(?:\.\/).*\.tsx?$/y]) {
    const { regex } = transform(original);
    assert.equal(regex.flags, original.flags);
    for (const route of ['./index.tsx', './nested/index.tsx', './same/same.tsx', './same/other.tsx', './INDEX.tsx', './generate+api.tsx']) {
      original.lastIndex = 0;
      regex.lastIndex = 0;
      assert.equal(regex.test(route), original.test(route), `${original}: ${route}`);
    }
    regex.lastIndex = 0;
    assert.equal(regex.test('./__design.tsx'), false);
  }
});

test('only require.context with a regexp literal as its third argument is transformed', () => {
  for (const code of [
    'export const ctx = other.context("root", true, /^.*\\.tsx$/);',
    'export const ctx = require.context("root", true, customFilter);',
    'export const ctx = require.context("root", true, new RegExp(".*"));',
    'export const ctx = require.other("root", true, /^.*\\.tsx$/);',
  ]) {
    const result = transform(patterns['_ctx.js'], { code });
    assert.equal(result.code.includes('__design'), false);
  }
});

test('require.context root, recursive flag and import mode are unchanged', () => {
  const { ast } = transform(patterns['_ctx.web.js']);
  const args = ast.program.body[0].declaration.declarations[0].init.arguments;
  assert.equal(args[0].object.object.name, 'process');
  assert.equal(args[0].property.name, 'EXPO_ROUTER_APP_ROOT');
  assert.equal(args[1].value, true);
  assert.equal(args[3].property.name, 'EXPO_ROUTER_IMPORT_MODE');
});

test('normalizes Windows paths and package-manager nested node_modules paths', () => {
  for (const filename of [
    'C:\\project\\node_modules\\expo-router\\_ctx.web.js',
    path.join(process.cwd(), 'node_modules', '.pnpm', 'expo-router@58', 'node_modules', 'expo-router', '_ctx.web.js'),
  ]) {
    const { regex } = transform(patterns['_ctx.web.js'], { filename });
    assert.equal(regex.test('./__design.tsx'), false, filename);
    assert.equal(regex.test('./projects/[id].tsx'), true, filename);
  }
});

test('applying the plugin twice is idempotent', () => {
  const first = transform(patterns['_ctx.web.js']);
  const second = transform(patterns['_ctx.web.js'], { code: first.code });
  assert.equal(second.regex.source, first.regex.source);
  assert.equal(second.code, first.code);
});
