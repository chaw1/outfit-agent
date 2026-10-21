import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LEGAL_VERSION, PRIVACY_CONSENT_KEY } from '../src/lib/legalConsent';

const screenshots = path.resolve('screenshots');
const apiBase = process.env.E2E_API_BASE || 'http://localhost:19301/api';

async function screenshot(page: Page, file: string) {
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, file), animations: 'disabled' });
}

test('第十轮：先同意隐私再引导，注册必须明确同意当前协议', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '隐私提示', exact: true })).toBeVisible();
  await expect(page.getByTestId('onboarding-1')).toHaveCount(0);
  await screenshot(page, '110-privacy-before-onboarding.png');

  await page.getByRole('button', { name: '暂不使用', exact: true }).click();
  await expect(page.getByRole('heading', { name: '暂不使用衣序', exact: true })).toBeVisible();
  await expect(page.getByText('你尚未同意，暂时无法进入服务。可阅读协议后重新选择。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('onboarding-1')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), PRIVACY_CONSENT_KEY)).toBeNull();
  await screenshot(page, '111-privacy-declined.png');

  await page.getByRole('button', { name: '查看协议', exact: true }).click();
  await expect(page).toHaveURL(/\/legal\/privacy$/);
  const privacy = page.getByTestId('legal-privacy');
  await expect(privacy).toBeVisible();
  await expect(privacy).toContainText(`版本 ${LEGAL_VERSION} · 衣序（演示版）`);
  await expect(privacy).toContainText('97000945@qq.com');
  await screenshot(page, '112-privacy-readable.png');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('heading', { name: '暂不使用衣序', exact: true })).toBeVisible();
  await expect(page.getByTestId('onboarding-1')).toHaveCount(0);

  await page.getByRole('button', { name: '同意并继续', exact: true }).click();
  for (let index = 1; index <= 3; index += 1) {
    await expect(page.getByTestId(`onboarding-${index}`)).toBeVisible();
    if (index === 1) await screenshot(page, '113-onboarding-after-consent.png');
    await page.getByRole('button', { name: index === 3 ? '开始创作' : '下一步', exact: true }).click();
  }
  expect(await page.evaluate(key => localStorage.getItem(key), PRIVACY_CONSENT_KEY)).toBe(LEGAL_VERSION);
  await page.reload();
  await expect(page.getByRole('button', { name: '登录，继续创作', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '隐私提示', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('onboarding-1')).toHaveCount(0);

  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill(`account_${Date.now()}`);
  await page.getByLabel('密码', { exact: true }).fill('Local-account-2026');
  const consent = page.getByRole('checkbox', { name: '我已阅读并同意《用户协议》和《隐私政策》', exact: true });
  const register = page.getByRole('button', { name: '创建账号，开始创作', exact: true });
  await expect(consent).not.toBeChecked();
  await expect(register).toBeDisabled();
  await expect(page.getByText('请先阅读并勾选同意，再创建账号。', { exact: true })).toBeVisible();
  await register.scrollIntoViewIfNeeded();
  await screenshot(page, '114-registration-requires-consent.png');
  await consent.check();
  await expect(consent).toBeChecked();
  await expect(register).toBeEnabled();
  await screenshot(page, '115-registration-consented.png');

  // 拦截提交以核对字段，本阶段不在假服务创建账号。
  await page.route(`${apiBase}/auth/register`, route => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'CONSENT_CHECK_ONLY', message: '协议字段已核对。' } }),
  }));
  const request = page.waitForRequest(value => value.method() === 'POST' && value.url() === `${apiBase}/auth/register`);
  await register.click();
  expect((await request).postDataJSON()).toMatchObject({ agreed_legal_version: LEGAL_VERSION });
  await expect(page.getByText('协议字段已核对。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBeNull();
  expect(pageErrors).toEqual([]);
});
