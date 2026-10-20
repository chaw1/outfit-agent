import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Field, Header, Notice, Page, colors, errorText, styles } from '../components/ui';
import { useSession } from '../context/Session';

export default function Settings() {
  const { baseUrl, setBaseUrl, signOut, token, user } = useSession();
  const router = useRouter();
  const [url, setUrl] = useState(baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function save() {
    setBusy(true); setError('');
    try { await setBaseUrl(url); setSaved(true); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Page><Header title="设置" onBack={() => router.canGoBack() ? router.back() : router.replace(token ? '/' : '/login')} /><View style={[styles.content, { gap: 25 }]}>
    <View><Text style={styles.title}>创作偏好</Text><Text style={[styles.subtitle, { marginTop: 8 }]}>连上你的服务，灵感就能继续。</Text></View>
    <Field label="服务器地址" value={url} onChangeText={value => { setUrl(value); setSaved(false); }} placeholder="https://你的服务地址" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
    <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 21 }}>本地演示：填写电脑的局域网 IP 和端口 19301。手机与电脑需要连接同一个 Wi-Fi。{ '\n' }线上服务：填写 HTTPS 地址。{ '\n' }切换地址后需要重新登录。</Text>
    {!!error && <Notice text={error} />}
    {saved && <Text accessibilityRole="alert" style={{ color: colors.green, fontSize: 13 }}>已保存，可以开始创作了。</Text>}
    <Button title="保存服务器地址" loading={busy} onPress={() => void save()} />
    {token && <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 24, gap: 14 }}><Text style={styles.subtitle}>当前账号：{user?.nickname || user?.username || '已登录'}</Text><Button title="退出登录" variant="secondary" onPress={() => { void signOut().then(() => router.replace('/login')).catch(e => setError(errorText(e))); }} /></View>}
    <Text style={{ textAlign: 'center', fontSize: 11, color: '#B2AEA5', paddingTop: 26 }}>衣序 OUTFIT NOTES · 1.0.0</Text>
  </View></Page>;
}
