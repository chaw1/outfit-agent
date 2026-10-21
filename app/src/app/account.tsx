import { usePreventRemove, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { LegalLinks } from '../components/LegalLinks';
import { RecoveryCode } from '../components/RecoveryCode';
import { Button, Field, Header, Notice, Page, errorText, styles } from '../components/ui';
import { useSession } from '../context/Session';
import { isRecoveryCode } from '../lib/recoveryCode';
import { space } from '../theme';

type AccountView = 'summary' | 'password' | 'recovery';

export default function Account() {
  const { api, user, token, signIn } = useSession();
  const router = useRouter();
  const [view, setView] = useState<AccountView>('summary');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  usePreventRemove(busy && !!token, () => setError('正在更新账号，请等待结果后再返回。'));
  function open(next: AccountView) {
    setView(next); setPassword(''); setNewPassword(''); setError(''); setMessage('');
  }
  async function changePassword() {
    if (!password) return setError('请填写当前密码。');
    if (newPassword.length < 8) return setError('新密码至少 8 位。');
    if (newPassword === password) return setError('新密码需要与当前密码不同。');
    setBusy(true); setError('');
    try {
      const result = await api.changePassword({ current_password: password, new_password: newPassword });
      await signIn(result);
      open('summary'); setMessage('密码已修改，其他设备需要重新登录。');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function regenerate() {
    if (!password) return setError('请填写当前账号的密码。');
    setBusy(true); setError('');
    try {
      const result = await api.regenerateRecoveryCode(password);
      if (!isRecoveryCode(result.recovery_code)) throw new Error('服务未返回有效恢复码，请重试。');
      setCode(result.recovery_code); setPassword('');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (code) return <RecoveryCode code={code} renewed onSaved={async () => {
    setCode(''); open('summary');
    if (!token) router.replace('/login');
    else setMessage('新的恢复码已保存，旧码已作废。');
  }} />;
  const title = view === 'password' ? '修改密码' : view === 'recovery' ? '重新生成恢复码' : '账号与安全';
  return <Page>
    <Header title={title} onBack={() => { if (busy) return; if (view !== 'summary') open('summary'); else if (router.canGoBack()) router.back(); else router.replace('/settings'); }} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {!!error && <Notice text={error} />}
      {!!message && <Text accessibilityRole="status" style={styles.subtitle}>{message}</Text>}
      {view === 'summary' ? <>
        <View style={{ gap: space.sm }}><Text style={styles.section}>当前账号</Text><Text selectable style={styles.subtitle}>{user?.username || '正在读取账号…'}</Text></View>
        <Button title="修改密码" variant="secondary" onPress={() => open('password')} />
        <View style={{ gap: space.md }}><Text style={styles.section}>恢复码</Text><Text style={styles.subtitle}>恢复码是忘记密码时唯一的找回方式。如怀疑泄露或没有保存，请验证密码并生成新码。</Text><Button title="重新生成恢复码" variant="secondary" onPress={() => open('recovery')} /></View>
        <Text style={styles.section}>协议与隐私</Text><LegalLinks />
      </> : view === 'password' ? <>
        <Text style={styles.subtitle}>修改后，其他设备的登录会立即失效。当前设备继续使用新登录凭证，已保存的恢复码仍可使用。</Text>
        <Field label="当前密码" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" editable={!busy} />
        <Field label="新密码" placeholder="至少 8 位" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" editable={!busy} onSubmitEditing={() => { if (!busy) void changePassword(); }} />
        <Button title="保存新密码" loading={busy} onPress={() => void changePassword()} />
      </> : <>
        <Text style={styles.subtitle}>生成后旧恢复码立即作废，新码只展示一次。请准备好安全的保存位置。</Text>
        <Field label="验证密码" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" editable={!busy} onSubmitEditing={() => { if (!busy) void regenerate(); }} />
        <Button title="生成新恢复码" loading={busy} onPress={() => void regenerate()} />
      </>}
    </ScrollView>
  </Page>;
}
