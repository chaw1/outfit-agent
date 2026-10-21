import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { LEGAL_VERSION, PRIVACY_CONSENT_KEY } from '../src/lib/legalConsent';

const screenshots = path.resolve('screenshots');
const apiBase = process.env.E2E_API_BASE || 'http://localhost:19301/api';

async function screenshot(page: Page, file: string) {
  await mkdir(screenshots, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).filter(image => {
      const bounds = image.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight;
    }).map(image => image.decode().catch(() => undefined)));
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(screenshots, file), animations: 'disabled' });
}

test.use({ storageState: { cookies: [], origins: [] } });

test('第十轮：隐私、注册、账号安全与注销完整闭环', async ({ page, request }) => {
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
  const privacyGate = page.getByTestId('privacy-gate');
  await privacyGate.getByRole('link', { name: '用户协议', exact: true }).focus();
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab');
    await expect.poll(() => privacyGate.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
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
    await page.getByRole('button', { name: index === 3 ? '进入片场' : '下一步', exact: true }).click();
  }
  expect(await page.evaluate(key => localStorage.getItem(key), PRIVACY_CONSENT_KEY)).toBe(LEGAL_VERSION);
  await page.reload();
  await expect(page.getByRole('button', { name: '登录，继续创作', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '隐私提示', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('onboarding-1')).toHaveCount(0);

  await page.getByRole('button', { name: '注册', exact: true }).click();
  const username = `account_${Date.now()}`;
  const originalPassword = 'Local-account-2026';
  const changedPassword = 'Local-changed-2026';
  const recoveredPassword = 'Local-recovered-2026';
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(originalPassword);
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

  const registrationRequest = page.waitForRequest(value => value.method() === 'POST' && value.url() === `${apiBase}/auth/register`);
  const registrationResponse = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === `${apiBase}/auth/register`);
  await register.click();
  expect((await registrationRequest).postDataJSON()).toMatchObject({ agreed_legal_version: LEGAL_VERSION });
  const registered = await registrationResponse;
  expect(registered.ok()).toBe(true);
  const registration = await registered.json() as { token: string; recovery_code: string; user: { id: string } };
  expect(registration.recovery_code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i);
  expect(registration.recovery_code.replaceAll('-', '')).toHaveLength(12);
  const recoveryCode = page.getByTestId('recovery-code');
  await expect(recoveryCode).toContainText(registration.recovery_code);
  expect(await page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBeNull();
  await page.getByRole('button', { name: '复制恢复码', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(registration.recovery_code);
  await screenshot(page, '116-registration-recovery-code.png');
  await page.getByRole('button', { name: '我已保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '拍一组新片', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBe(registration.token);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账号与安全', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('当前账号', { exact: true })).toBeVisible();
  await expect(page.getByText(username, { exact: true })).toBeVisible();
  await screenshot(page, '120-account-security.png');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('当前密码', { exact: true }).fill(originalPassword);
  await page.getByLabel('新密码', { exact: true }).fill(changedPassword);
  const passwordResponse = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === `${apiBase}/me/password`);
  await page.getByRole('button', { name: '保存新密码', exact: true }).click();
  const passwordChanged = await passwordResponse;
  expect(passwordChanged.ok()).toBe(true);
  const passwordAuth = await passwordChanged.json() as { token: string };
  await expect(page.getByText('密码已修改，其他设备需要重新登录。', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBe(passwordAuth.token);
  const invalidatedSession = await request.get(`${apiBase}/me`, { headers: { Authorization: `Bearer ${registration.token}` } });
  expect(invalidatedSession.status()).toBe(401);
  const originalLogin = await request.post(`${apiBase}/auth/login`, { data: { username, password: originalPassword } });
  expect(originalLogin.status()).toBe(401);
  const changedLogin = await request.post(`${apiBase}/auth/login`, { data: { username, password: changedPassword } });
  expect(changedLogin.ok()).toBe(true);
  await screenshot(page, '121-password-changed.png');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录，继续创作', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill(username);
  const loginPassword = page.getByLabel('密码', { exact: true }).filter({ visible: true });
  await loginPassword.fill(originalPassword);
  const rejectedLoginResponse = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === `${apiBase}/auth/login`);
  await page.getByRole('button', { name: '登录，继续创作', exact: true }).click();
  const rejectedLogin = await rejectedLoginResponse;
  expect(rejectedLogin.status()).toBe(401);
  const rejectedLoginError = await rejectedLogin.json() as { error: { message: string } };
  await expect(page.getByText(rejectedLoginError.error.message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBeNull();
  await loginPassword.fill(changedPassword);
  await page.getByRole('button', { name: '登录，继续创作', exact: true }).click();
  await expect(page.getByRole('button', { name: '拍一组新片', exact: true })).toBeVisible();
  await screenshot(page, '121-password-login-verified.png');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录，继续创作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '忘记密码？', exact: true }).click();
  await expect(page).toHaveURL(/\/forgot$/);
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill(username);
  await page.getByLabel('恢复码', { exact: true }).fill(registration.recovery_code);
  await page.getByLabel('新密码', { exact: true }).fill(recoveredPassword);
  await screenshot(page, '117-forgot-password.png');
  const recoveryResponse = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === `${apiBase}/auth/recover`);
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  const recovered = await recoveryResponse;
  expect(recovered.ok()).toBe(true);
  const recovery = await recovered.json() as { token: string; recovery_code: string };
  expect(recovery.recovery_code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i);
  expect(recovery.recovery_code).not.toBe(registration.recovery_code);
  await expect(recoveryCode).toContainText(recovery.recovery_code);
  expect(await page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBeNull();
  page.once('dialog', dialog => void dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/\/forgot$/);
  await expect(recoveryCode).toContainText(recovery.recovery_code);
  await expect(page.getByText('请先安全保存恢复码，再点“我已保存”。', { exact: true })).toBeVisible();
  await screenshot(page, '118-password-reset-new-recovery-code.png');
  await page.getByRole('button', { name: '我已保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '拍一组新片', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBe(recovery.token);
  await screenshot(page, '119-recovered-account.png');

  const reusedCode = await request.post(`${apiBase}/auth/recover`, { data: { username, recovery_code: registration.recovery_code, new_password: 'Do-not-apply-2026' } });
  expect(reusedCode.ok()).toBe(false);
  expect((await reusedCode.json()).error.code).toBe('RECOVERY_FAILED');
  const oldLogin = await request.post(`${apiBase}/auth/login`, { data: { username, password: originalPassword } });
  expect(oldLogin.status()).toBe(401);
  const newLogin = await request.post(`${apiBase}/auth/login`, { data: { username, password: recoveredPassword } });
  expect(newLogin.ok()).toBe(true);
  const staleSession = await request.get(`${apiBase}/me`, { headers: { Authorization: `Bearer ${registration.token}` } });
  expect(staleSession.status()).toBe(401);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账号与安全', exact: true }).click();
  await page.getByRole('button', { name: '重新生成恢复码', exact: true }).click();
  await page.getByLabel('验证密码', { exact: true }).fill('Wrong-password-2026');
  const wrongPasswordResponse = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === `${apiBase}/me/recovery-code`);
  await page.getByRole('button', { name: '生成新恢复码', exact: true }).click();
  const wrongPassword = await wrongPasswordResponse;
  expect(wrongPassword.ok()).toBe(false);
  const wrongPasswordError = await wrongPassword.json() as { error: { message: string } };
  await expect(page.getByText(wrongPasswordError.error.message, { exact: true })).toBeVisible();
  await expect(recoveryCode).toHaveCount(0);
  await screenshot(page, '122-recovery-code-password-check.png');
  await page.getByLabel('验证密码', { exact: true }).fill(recoveredPassword);
  let releaseGeneration = () => {};
  const generationGate = new Promise<void>(resolve => { releaseGeneration = resolve; });
  await page.route(`${apiBase}/me/recovery-code`, async route => {
    await generationGate;
    await route.continue();
  });
  const regeneratedResponse = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === `${apiBase}/me/recovery-code`);
  await page.getByRole('button', { name: '生成新恢复码', exact: true }).click();
  try {
    await page.goBack();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText('正在更新账号，请等待结果后再返回。', { exact: true })).toBeVisible();
  } finally { releaseGeneration(); }
  const regenerated = await regeneratedResponse;
  expect(regenerated.ok()).toBe(true);
  const latestRecoveryCode = (await regenerated.json() as { recovery_code: string }).recovery_code;
  expect(latestRecoveryCode).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i);
  expect(latestRecoveryCode).not.toBe(recovery.recovery_code);
  await expect(recoveryCode).toContainText(latestRecoveryCode);
  await screenshot(page, '123-regenerated-recovery-code.png');
  await page.getByRole('button', { name: '我已保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '修改密码', exact: true })).toBeVisible();
  const outdatedRecoveryCode = await request.post(`${apiBase}/auth/recover`, { data: { username, recovery_code: recovery.recovery_code, new_password: 'Do-not-apply-2026' } });
  expect(outdatedRecoveryCode.ok()).toBe(false);
  expect((await outdatedRecoveryCode.json()).error.code).toBe('RECOVERY_FAILED');

  await page.getByRole('button', { name: '注销账号', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/delete$/);
  await expect(page.getByText('注销账号', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/全部项目/).filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/上传照片/).filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/生成图片和视频/).filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/无法恢复/).filter({ visible: true })).toBeVisible();
  await screenshot(page, '124-delete-account-confirmation.png');
  await page.getByRole('button', { name: '取消注销', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole('button', { name: '注销账号', exact: true }).click();
  await page.getByLabel('确认账号密码', { exact: true }).fill('Wrong-password-2026');
  const rejectedDeletionResponse = page.waitForResponse(value => value.request().method() === 'DELETE' && value.url() === `${apiBase}/me`);
  await page.getByRole('button', { name: '确认注销', exact: true }).click();
  const rejectedDeletion = await rejectedDeletionResponse;
  expect(rejectedDeletion.ok()).toBe(false);
  const rejectedDeletionError = await rejectedDeletion.json() as { error: { message: string } };
  await expect(page.getByText(rejectedDeletionError.error.message, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/account\/delete$/);
  const deletedToken = await page.evaluate(() => sessionStorage.getItem('outfit.session'));
  expect(deletedToken).toBeTruthy();
  await page.getByLabel('确认账号密码', { exact: true }).fill(recoveredPassword);
  const deletedResponse = page.waitForResponse(value => value.request().method() === 'DELETE' && value.url() === `${apiBase}/me`);
  await page.getByRole('button', { name: '确认注销', exact: true }).click();
  expect((await deletedResponse).ok()).toBe(true);
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await expect(page.getByText('账号已注销', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('outfit.session'))).toBeNull();
  await screenshot(page, '125-account-deleted-login.png');

  const deletedSession = await request.get(`${apiBase}/me`, { headers: { Authorization: `Bearer ${deletedToken}` } });
  expect(deletedSession.status()).toBe(401);
  const deletedLogin = await request.post(`${apiBase}/auth/login`, { data: { username, password: recoveredPassword } });
  expect(deletedLogin.status()).toBe(401);
  const deletedRecovery = await request.post(`${apiBase}/auth/recover`, { data: { username, recovery_code: latestRecoveryCode, new_password: 'Do-not-apply-2026' } });
  expect(deletedRecovery.ok()).toBe(false);
  expect((await deletedRecovery.json()).error.code).toBe('RECOVERY_FAILED');
  const recreated = await request.post(`${apiBase}/auth/register`, { data: { username, password: 'Local-recreated-2026', agreed_legal_version: LEGAL_VERSION } });
  expect(recreated.ok()).toBe(true);
  expect((await recreated.json()).user.id).not.toBe(registration.user.id);
  expect(pageErrors).toEqual([]);
});
