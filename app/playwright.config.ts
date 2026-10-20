import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { existsSync } from 'node:fs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.tools/browsers');
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    baseURL: 'http://localhost:19300',
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
    { command: 'npm run mock', url: 'http://localhost:19301/api/health', timeout: 30_000, reuseExistingServer: true, env: { MOCK_PREVIEW_DELAY_MS: '4500' } },
    { command: 'npm run web -- --host localhost --no-dev --minify', url: 'http://localhost:19300', timeout: 120_000, reuseExistingServer: true, env: { CI: '1', BROWSER: 'none', EXPO_PUBLIC_API_BASE: 'http://localhost:19301' } },
  ],
});
