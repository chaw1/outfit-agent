import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ProfileEditor } from '../components/ProfileEditor';
import { supportsProfile } from '../lib/profile';
import { AnimatedEntry, Button, Field, Header, Notice, Page, Toast, errorText, styles } from '../components/ui';
import { colors, radius, space, type } from '../theme';
import { LegalLinks } from '../components/LegalLinks';
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
  return <Page><Header title="设置" onBack={() => router.canGoBack() ? router.back() : router.replace(token ? '/' : '/login')} /><ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
    {token && <AnimatedEntry style={localStyles.profileSection}>{supportsProfile(user) ? <ProfileEditor key={`${baseUrl}:${user.id}`} user={user} /> : <View style={{ gap: space.sm }}><Text style={styles.section}>我的形象</Text><Text style={styles.subtitle}>当前服务未开通我的形象，现有创作功能可以继续使用。</Text></View>}</AnimatedEntry>}
    <View style={localStyles.serviceSection}>
      <View style={{ gap: space.sm }}><Text style={styles.section}>创作偏好</Text><Text style={styles.subtitle}>连上你的服务，灵感就能继续。</Text></View>
      <Field label="服务器地址" value={url} onChangeText={value => { setUrl(value); setSaved(false); }} placeholder="https://你的服务地址" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <View style={localStyles.helpCard}><Text style={localStyles.helpText}>本地演示：填写电脑的局域网 IP 和端口 19301。手机与电脑需要连接同一个 Wi-Fi。{ '\n' }线上服务：填写 HTTPS 地址。{ '\n' }切换地址后需要重新登录。</Text></View>
      {!!error && <Notice text={error} />}
      {saved && <Toast text="已保存，可以开始创作了。" tone="success" onDismiss={() => setSaved(false)} />}
      <Button title="保存服务器地址" loading={busy} onPress={() => void save()} />
    </View>
    {token && <View style={localStyles.accountSection}><Text style={styles.subtitle}>当前账号：{user?.nickname || user?.username || '已登录'}</Text><Button title="账号与安全" variant="secondary" onPress={() => router.push('/account')} /><Button title="退出登录" variant="secondary" onPress={() => { void signOut().then(() => router.replace('/login')).catch(e => setError(errorText(e))); }} /></View>}
    <Button title="关于衣序与隐私" variant="ghost" onPress={() => router.push('/about')} />
    <LegalLinks />
    <Text style={localStyles.footer}>衣序 OUTFIT NOTES · 1.0.0</Text>
  </ScrollView></Page>;
}

const localStyles = StyleSheet.create({
  profileSection: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: space.xl },
  serviceSection: { gap: space.lg },
  helpCard: { backgroundColor: colors.paper, borderRadius: radius.md, padding: space.lg },
  helpText: { ...type.caption, color: colors.muted },
  accountSection: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.xl, gap: space.lg },
  footer: { ...type.badge, textAlign: 'center', color: colors.muted, paddingTop: space.sm },
});
