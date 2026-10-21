import { usePreventRemove, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { Button, Field, Header, Notice, Page, errorText, styles } from '../../components/ui';
import { useSession } from '../../context/Session';

export default function DeleteAccount() {
  const { api, user, token, baseUrl, signOut, isCurrentSession } = useSession();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  usePreventRemove(busy && !!token, () => setError('正在注销账号，请等待结果。'));
  function cancel() { if (!busy) { if (router.canGoBack()) router.back(); else router.replace('/account'); } }
  async function remove() {
    if (busy) return;
    if (!password) return setError('请输入账号密码，确认是你本人操作。');
    setBusy(true); setError('');
    try {
      await api.deleteAccount(password);
      if (isCurrentSession(token, baseUrl) || isCurrentSession(null, baseUrl)) await signOut('deleted');
      if (isCurrentSession(null, baseUrl)) router.replace({ pathname: '/login', params: { deleted: '1' } });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Page>
    <Header title="注销账号" onBack={cancel} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text style={styles.section}>确认注销 {user?.username || '当前账号'}？</Text>
      <Text style={styles.subtitle}>注销后将立即清理这个账号的全部项目、对话、上传照片、参考图与生成图片和视频。所有设备的登录和恢复码都会失效，原用户名会被释放。</Text>
      <Notice text="注销无法撤销，清理的数据无法恢复。请先自行保存需要的作品。" />
      <Field label="确认账号密码" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" editable={!busy} onSubmitEditing={() => { if (!busy) void remove(); }} />
      {!!error && <Notice text={error} />}
      <Button title="确认注销" variant="danger" loading={busy} onPress={() => void remove()} />
      <Button title="取消注销" variant="secondary" disabled={busy} onPress={cancel} />
    </ScrollView>
  </Page>;
}
