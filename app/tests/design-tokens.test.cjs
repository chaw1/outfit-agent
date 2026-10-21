'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const appDir = process.env.APP_DIR || path.dirname(require.resolve('../package.json'));
const { ESLint, RuleTester } = require(require.resolve('eslint', { paths: [appDir] }));
const plugin = require('../scripts/eslint/design-tokens.cjs');
RuleTester.it = (name, run) => {
  try { run(); } catch (error) { console.error(`FAILED CASE: ${name}`); throw error; }
};

const languageOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
  parserOptions: { ecmaFeatures: { jsx: true } },
};
const tester = new RuleTester({ languageOptions });
let caseCount = 0;
const invalid = (code, messageId) => {
  caseCount += 1;
  return { code, errors: [{ messageId }] };
};
const valid = code => { caseCount += 1; return code; };

tester.run('design-tokens/no-raw-colors', plugin.rules['no-raw-colors'], {
  valid: [
    'const style = { color: studio.ink, backgroundColor: colors.paper };',
    'const value = "https://example.com/image#abcdef";',
    'const value = "not-a-color #12345";',
    'const value = "not-a-color #abcdefg";',
    'const style = { color: "transparent" };',
    'const note = "number 123456 and hashless ff2442";',
  ].map(valid),
  invalid: [
    'const style = { color: "#fff" };',
    'const style = { color: "#abcd" };',
    'const style = { color: "#112233" };',
    'const style = { color: "#11223344" };',
    'const style = { color: `#fff` };',
    'const style = { color: "rgba(0,0,0,.7)" };',
    'const style = { color: "rgb(0 0 0 / .7)" };',
    'const style = { color: "hsl(0 0% 50%)" };',
    'const style = { color: "hsla(0,0%,50%,.7)" };',
    'const style = { border: "1px solid #fff" };',
    'const style = { background: "linear-gradient(#fff,#000)" };',
    'const markup = `<path fill="#fff">`;',
    'const style = { color: `rgba(${r},${g},${b},.7)` };',
    'const style = { color: `#${"fff"}` };',
    'const style = { color: "#" + "fff" };',
    'const raw = "fff"; const style = { color: "#" + raw };',
    'const component = <View color="#fff" />;',
  ].map(code => invalid(code, 'rawColor')),
});

tester.run('design-tokens/no-magic-spacing', plugin.rules['no-magic-spacing'], {
  valid: [
    'const style = { gap: space.sm };',
    'const style = { marginLeft: -space.offset };',
    'const style = { paddingBottom: space.xl + insets.bottom };',
    'const style = { marginTop: items.length > 1 ? space.sm : space.md };',
    'const style = { marginTop: items.length > 1 && space.sm };',
    'const style = { margin: "auto" };',
    'const style = { width: 20, opacity: .7, imageRatio: 3 / 4, timeout: 30000 };',
    'const component = <View hitSlop={space.sm} />;',
    'const component = <View hitSlop={{ top: space.sm, left: space.sm }} />;',
    'const component = <View style={{ gap: space.sm }} />;',
    'const gap = space.sm; const style = { gap };',
    'const gap = space.sm; function render(gap) { return { gap }; }',
    'const gap = space.sm; { const gap = space.md; const style = { gap }; }',
    'const offsets = { normal: space.sm }; const style = { gap: offsets.normal };',
    'const gaps = [space.sm]; const style = { gap: gaps[0] };',
    'const style = { padding: Math.max(insets.bottom, space.md) };',
    'const style = { gap: ready ? space.sm : space.md, columnGap: space.lg };',
    'const style = { marginTop: !items.length && space.sm };',
    'const style = { gap: 0 && space.sm };',
    'const values = [space.sm, space.md]; const style = { gap: values.at(1) };',
    'const getGap = id => id === 1 ? space.sm : space.md; const style = { gap: getGap(1) };',
    'const count = 2; const style = { gap: count && space.sm };',
    'const props = { paddingStatus: 2, marginRate: .3, hitSlopLabel: 4 };',
  ].map(valid),
  invalid: [
    'const style = { margin: 8 };',
    'const style = { ["paddingTop"]: -10 };',
    'const style = { gap: 0 };',
    'const style = { rowGap: 8 };',
    'const style = { columnGap: 8 };',
    'const style = { paddingInlineStart: 8 };',
    'const style = { marginBlockEnd: 8 };',
    'const component = <View hitSlop={8} />;',
    'const component = <View hitSlop="8" />;',
    'const component = <View hitSlop={{ top: 8, bottom: space.sm }} />;',
    'const component = <View hitSlop={{ ...{ left: 8 }, bottom: space.sm }} />;',
    'const style = { marginTop: ready ? space.sm : 2 };',
    'const style = { padding: space.sm + 2 };',
    'const style = { padding: space.sm * .5 };',
    'const style = { padding: "8px 16px" };',
    'const style = { margin: "-10px 0" };',
    'const style = { padding: "10%" };',
    'const style = { padding: `8px ${space.sm}px` };',
    'const style = { padding: `${8}px` };',
    'const style = { padding: String.raw`8px` };',
    'const style = { gap: Math.max(space.sm, 2) };',
    'const style = { gap: [space.sm, 8] };',
    'const style = { gap: ready && 8 };',
    'const style = { gap: value ?? 8 };',
    'const style = { gap: 8 || space.sm };',
    'const style = { gap: 8 ?? space.sm };',
    'const gap = 8; const style = { gap };',
    'const gap = 8; const alias = gap; const style = { gap: alias };',
    'const offsets = { normal: 8 }; const style = { gap: offsets.normal };',
    'const gaps = [8]; const style = { gap: gaps[0] };',
    'const gap = space.sm; { const gap = 8; const style = { gap }; }',
    'const hit = { top: 8 }; const component = <View hitSlop={hit} />;',
    'const style = { gap: (() => 8)() };',
    'const computeGap = () => 8; const style = { gap: computeGap(1) };',
    'const style = { gap: (() => { if (items.length > 1) return 8; return space.sm; })() };',
    'const style = { gap: (items.length = 1, 8) };',
  ].map(code => invalid(code, 'magicSpacing')),
});

(async () => {
  const eslint = new ESLint({
    cwd: appDir,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['src/**/*.{js,jsx,ts,tsx}'], languageOptions },
      {
        files: ['src/**/*.{js,jsx,ts,tsx}'],
        ignores: ['src/theme.ts', 'src/components/ds/**'],
        plugins: { 'design-tokens': plugin },
        rules: { 'design-tokens/no-raw-colors': 'error', 'design-tokens/no-magic-spacing': 'error' },
      },
    ],
  });
  const cases = [
    ['src/features/Example.tsx', 2],
    ['src/theme.ts', 0],
    ['src/components/ds/Card.tsx', 0],
    ['src/components/ds/nested/Card.tsx', 0],
  ];
  for (const [filePath, errorCount] of cases) {
    const [result] = await eslint.lintText('const style = { color: "#fff", gap: 8 };', { filePath: path.join(appDir, filePath) });
    assert.equal(result.errorCount, errorCount, filePath);
    assert.equal(result.warningCount, 0, filePath);
  }
  console.log(`PASS: ${caseCount} RuleTester cases + ${cases.length} scope/exemption integration cases.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
