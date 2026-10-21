import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('请先切换到 Node 22.13 或以上，再运行验证。');
  process.exit(1);
}
const directory = new URL('../verification/', import.meta.url);
mkdirSync(directory, { recursive: true });
const summary = { startedAt: new Date().toISOString(), node: process.version, sdk: '58', checks: [] };
const steps = [
  ['tokens', 'npm', ['run', 'tokens:check']],
  ['typecheck', 'npx', ['tsc', '--noEmit']],
  ['lint', 'npm', ['run', 'lint']],
  ['tests', 'npm', ['test']],
  ['ios', 'npx', ['expo', 'export', '--platform', 'ios', '--output-dir', 'dist/ios']],
  ['android', 'npx', ['expo', 'export', '--platform', 'android', '--output-dir', 'dist/android']],
];
for (const [name, command, args] of steps) {
  const start = Date.now();
  const result = spawnSync(command, args, { cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { ...process.env, CI: '1', BROWSER: 'none', FORCE_COLOR: '0' }, maxBuffer: 10 * 1024 * 1024 });
  const rawOutput = ((result.stdout || '') + (result.stderr || '') + (result.error?.message || '')).trimEnd();
  const output = rawOutput ? `${rawOutput}\n` : '';
  writeFileSync(new URL(`${name}.txt`, directory), output);
  const check = { name, command: [command, ...args].join(' '), exitCode: result.status ?? 1, durationMs: Date.now() - start, outputSha256: createHash('sha256').update(output).digest('hex') };
  if (name === 'tests') check.testsPassed = Number(output.match(/# pass (\d+)/)?.[1] || 0);
  if (result.status === 0 && (name === 'ios' || name === 'android')) check.bundleSha256 = createHash('sha256').update(readFileSync(new URL(`../dist/${name}/metadata.json`, import.meta.url))).digest('hex');
  summary.checks.push(check);
  summary.updatedAt = new Date().toISOString();
  writeFileSync(new URL('summary.json', directory), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${result.status === 0 ? '通过' : '失败'} ${name} (${check.durationMs} ms)`);
  if (result.status !== 0) { console.error(output); process.exit(1); }
}
