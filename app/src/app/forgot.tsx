import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import type { RecoveryAuthResponse } from '../api/types';
import { RecoveryCode } from '../components/RecoveryCode';
import { Button, Field, Header, Notice, Page, errorText, styles } from '../components/ui';
import { useSession } from '../context/Session';
import { isRecoveryCode, normalizeRecoveryCode } from '../lib/recoveryCode';

export default function ForgotPassword() {
  const router = useRouter();
  const { api, signIn } = useSession();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<RecoveryAuthResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function recover() {
    if (username.trim().length < 3 || username.trim().length > 32) return setError('请填写 3–32 位用户名。');
    if (!isRecoveryCode(code)) return setError('恢复码需要 12 位字母或数字，格式为 xxxx-xxxx-xxxx。');
    if (password.length < 8) return setError('新密码至少 8 位。');
    setBusy(true); setError('');
    try {
      const response = await api.recover({ username: username.trim(), recovery_code: normalizeRecoveryCode(code), new_password: password });
      if (!isRecoveryCode(response.recovery_code)) throw new Error('服务未返回有效的新恢复码，请重新登录后在账号与安全中生成。');
      setResult(response); setCode(''); setPassword('');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (result) return <RecoveryCode code={result.recovery_code} renewed onSaved={async () => { await signIn(result); setResult(null); router.replace('/'); }} />;
  return <Page>
    <Header title="忘记密码" onBack={() => router.canGoBack() ? router.back() : router.replace('/login')} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text style={styles.subtitle}>输入注册时保存的恢复码，重置密码并领取新的恢复码。原登录和旧恢复码会立即失效。</Text>
      <Field label="用户名" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" />
      <Field label="恢复码" placeholder="xxxx-xxxx-xxxx" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} />
      <Field label="新密码" placeholder="至少 8 位" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" onSubmitEditing={() => void recover()} />
      {!!error && <Notice text={error} />}
      <Button title="重置密码" loading={busy} onPress={() => void recover()} />
    </ScrollView>
  </Page>;
}
