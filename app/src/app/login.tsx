import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Button, Field, IconButton, Notice, Page, colors, errorText, styles } from '../components/ui';
import { useSession } from '../context/Session';

export default function Login() {
  const { api, signIn } = useSession();
  const router = useRouter();
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (username.trim().length < 3 || username.trim().length > 32) return setError('用户名用 3–32 个字符就好。');
    if (password.length < 8) return setError('密码至少 8 位，再多一点更安心。');
    setBusy(true); setError('');
    try {
      const result = register ? await api.register({ username: username.trim(), password, nickname: nickname.trim() || undefined }) : await api.login({ username: username.trim(), password });
      await signIn(result); router.replace('/');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Page scroll contentStyle={{ flexGrow: 1, paddingTop: 18 }}>
    <View style={{ alignItems: 'flex-end' }}><IconButton name="options-outline" label="服务器设置" onPress={() => router.push('/settings')} /></View>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', gap: 26, paddingBottom: 30 }}>
      <View style={{ gap: 16, marginBottom: 8 }}>
        <View style={{ backgroundColor: colors.red, width: 62, height: 62, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}><Ionicons name="shirt-outline" size={31} color="white" /></View>
        <View style={styles.row}><Text style={{ fontSize: 37, fontWeight: '800', letterSpacing: 2, color: colors.ink }}>衣序</Text><Text style={{ fontSize: 10, letterSpacing: 2, color: colors.muted, paddingTop: 8 }}>OUTFIT NOTES</Text></View>
        <Text style={{ fontSize: 24, lineHeight: 35, fontWeight: '600', color: colors.ink }}>好穿搭，也值得{ '\n' }一篇好笔记。</Text>
        <Text style={styles.subtitle}>从一件衣服的灵感，到你的下一篇品牌合作。</Text>
      </View>
      <View style={{ flexDirection: 'row', backgroundColor: colors.paper, borderRadius: 13, padding: 4 }}>
        {['登录', '注册'].map((label, index) => <Pressable key={label} accessibilityRole="button" onPress={() => { setRegister(index === 1); setError(''); }} style={{ flex: 1, borderRadius: 10, padding: 12, backgroundColor: register === (index === 1) ? 'white' : 'transparent' }}><Text style={{ textAlign: 'center', fontWeight: '600', color: register === (index === 1) ? colors.ink : colors.muted }}>{label}</Text></Pressable>)}
      </View>
      <View style={{ gap: 18 }}>
        {register && <Field label="怎么称呼你" placeholder="你的博主昵称（选填）" value={nickname} onChangeText={setNickname} autoComplete="nickname" />}
        <Field label="用户名" placeholder="3–32 位用户名" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" />
        <Field label="密码" placeholder="至少 8 位" value={password} onChangeText={setPassword} secureTextEntry autoComplete={register ? 'new-password' : 'current-password'} onSubmitEditing={() => void submit()} />
        {!!error && <Notice text={error} />}
        <Button title={register ? '创建账号，开始创作' : '登录，继续创作'} loading={busy} onPress={() => void submit()} icon="arrow-forward" />
      </View>
      <Text style={{ color: colors.muted, fontSize: 11, textAlign: 'center' }}>你的品牌合作灵感，都从这里开始</Text>
    </KeyboardAvoidingView>
  </Page>;
}
