import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const liveBase = process.env.LIVE_API_BASE;
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.tools/browsers');

export default defineConfig({
  testDir: './e2e',
  testMatch: /live(?:-auto)?\.spec\.ts$/,
  timeout: 25 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/live',
  use: {
    baseURL: 'http://localhost:19310',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    headless: true,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined) },
    // Traces contain Authorization headers; live evidence is deliberately sanitized instead.
    trace: 'off',
    screenshot: 'only-on-failure',
    video: process.env.LIVE_VIDEO === '1' ? { mode: 'on', size: { width: 390, height: 844 } } : 'off',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: liveBase ? {
    command: 'npx expo start --web --port 19310 --host localhost --no-dev --minify',
    url: 'http://localhost:19310',
    timeout: 120_000,
    reuseExistingServer: true,
    env: { CI: '1', BROWSER: 'none', EXPO_PUBLIC_API_BASE: liveBase },
  } : undefined,
});
