import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { existsSync } from 'node:fs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.tools/browsers');
const webPort = Number(process.env.E2E_WEB_PORT || 19300);
const mockPort = Number(process.env.E2E_MOCK_PORT || 19301);
const webBase = `http://localhost:${webPort}`;
const mockBase = `http://localhost:${mockPort}`;
process.env.E2E_WEB_BASE = webBase;
process.env.E2E_API_BASE = `${mockBase}/api`;
process.env.E2E_MOCK_BASE = mockBase;
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './e2e',
  testIgnore: /live.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    baseURL: webBase,
    // 假服务用例默认已通过首次隐私提示；round10 自行覆盖以验证门控本身。
    storageState: { cookies: [], origins: [{ origin: webBase, localStorage: [{ name: 'outfit.privacy-consent', value: '2026-10-21' }] }] },
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    headless: true,
    actionTimeout: 15_000,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined) },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: [
    { command: 'npm run mock', url: `${mockBase}/api/health`, timeout: 30_000, reuseExistingServer: true, env: { PORT: String(mockPort), MOCK_PREVIEW_DELAY_MS: '4500' } },
    { command: `npx expo start --web --port ${webPort} --host localhost --no-dev --minify`, url: webBase, timeout: 120_000, reuseExistingServer: true, env: { CI: '1', BROWSER: 'none', EXPO_PUBLIC_API_BASE: mockBase } },
  ],
});
