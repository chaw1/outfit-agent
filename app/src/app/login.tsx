import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { AnimatedEntry, Button, Field, IconButton, Notice, Page, StatePanel, colors, errorText, styles } from '../components/ui';
import { useSession } from '../context/Session';
import { layout, radius, space, type } from '../theme';

export default function Login() {
  const { api, signIn } = useSession();
  const router = useRouter();
  const { expired } = useLocalSearchParams<{ expired?: string }>();
  const usernameInput = useRef<React.ComponentRef<typeof TextInput>>(null);
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
  return <Page scroll contentStyle={{ flexGrow: 1, paddingTop: space.lg }}>
    <View style={{ alignItems: 'flex-end' }}><IconButton name="options-outline" label="服务器设置" onPress={() => router.push('/settings')} /></View>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', gap: space.xl, paddingBottom: space.xxl }}>
      {expired !== '1' && <AnimatedEntry><View style={{ gap: space.lg, marginBottom: space.sm }}>
        <View style={{ backgroundColor: colors.red, width: 64, height: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm }}><Ionicons name="shirt-outline" size={31} color={colors.white} /></View>
        <View style={styles.row}><Text style={{ ...type.brand, color: colors.ink }}>衣序</Text><Text style={{ ...type.badge, letterSpacing: 2, color: colors.muted, paddingTop: space.sm }}>OUTFIT NOTES</Text></View>
        <Text style={{ ...type.title, color: colors.ink }}>好穿搭，也值得{ '\n' }一篇好笔记。</Text>
        <Text style={styles.subtitle}>从一件衣服的灵感，到你的下一篇品牌合作。</Text>
      </View>
      </AnimatedEntry>}
      {expired === '1' && <StatePanel icon="lock-closed-outline" title="登录已过期" description="重新登录，继续你的合作创作。" actionLabel="重新登录" onAction={() => usernameInput.current?.focus()} />}
      <View style={{ flexDirection: 'row', backgroundColor: colors.paper, borderRadius: radius.md, padding: space.xs }}>
        {['登录', '注册'].map((label, index) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: register === (index === 1) }} onPress={() => { setRegister(index === 1); setError(''); }} style={{ flex: 1, minHeight: layout.touch, justifyContent: 'center', borderRadius: radius.sm, padding: space.md, backgroundColor: register === (index === 1) ? colors.surface : 'transparent' }}><Text style={{ textAlign: 'center', fontWeight: '600', color: register === (index === 1) ? colors.ink : colors.muted }}>{label}</Text></Pressable>)}
      </View>
      <View style={{ gap: space.lg }}>
        {register && <Field label="怎么称呼你" placeholder="你的博主昵称（选填）" value={nickname} onChangeText={setNickname} autoComplete="nickname" />}
        <Field inputRef={usernameInput} label="用户名" placeholder="3–32 位用户名" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" />
        <Field label="密码" placeholder="至少 8 位" value={password} onChangeText={setPassword} secureTextEntry autoComplete={register ? 'new-password' : 'current-password'} onSubmitEditing={() => void submit()} />
        {!!error && <Notice text={error} />}
        <Button title={register ? '创建账号，开始创作' : '登录，继续创作'} loading={busy} onPress={() => void submit()} icon="arrow-forward" />
      </View>
      <Text style={{ color: colors.muted, ...type.caption, textAlign: 'center' }}>你的品牌合作灵感，都从这里开始</Text>
    </KeyboardAvoidingView>
  </Page>;
}
