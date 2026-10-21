import { existsSync } from 'node:fs';

import { defineConfig } from '@playwright/test';

const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'admin-ui.spec.ts',
  outputDir: '.tools/admin-ui-results',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined),
    },
    screenshot: 'only-on-failure',
  },
});
