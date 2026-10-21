import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, usePreventRemove, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { AnimatedEntry, Button, Field, IconButton, Notice, Page, StatePanel, colors, errorText, styles } from '../components/ui';
import type { AuthResponse } from '../api/types';
import { RecoveryCode } from '../components/RecoveryCode';
import { LegalConsent } from '../components/LegalConsent';
import { LEGAL_VERSION } from '../lib/legalConsent';
import { isRecoveryCode } from '../lib/recoveryCode';
import { LegalLinks } from '../components/LegalLinks';
import { useSession } from '../context/Session';
import { layout, radius, space, type } from '../theme';

export default function Login() {
  const { api, signIn } = useSession();
  const router = useRouter();
  const { expired, deleted } = useLocalSearchParams<{ expired?: string; deleted?: string }>();
  const usernameInput = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [register, setRegister] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState<AuthResponse | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  usePreventRemove(busy, () => setError('正在处理登录或注册，请等待结果后再返回。'));
  async function submit() {
    if (busy) return;
    if (register && !agreed) return setError('请先阅读并同意用户协议与隐私政策。');
    if (username.trim().length < 3 || username.trim().length > 32) return setError('用户名用 3–32 个字符就好。');
    if (password.length < 8) return setError('密码至少 8 位，再多一点更安心。');
    setBusy(true); setError('');
    try {
      const result = register ? await api.register({ username: username.trim(), password, nickname: nickname.trim() || undefined, agreed_legal_version: LEGAL_VERSION }) : await api.login({ username: username.trim(), password });
      if (register) {
        if (!result.recovery_code || !isRecoveryCode(result.recovery_code)) throw new Error('账号已创建，但未收到有效恢复码。请使用密码登录后，在账号与安全中重新生成恢复码。');
        setPending(result); setPassword('');
      }
      else { await signIn(result); router.replace('/'); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (pending?.recovery_code) return <RecoveryCode code={pending.recovery_code} onSaved={async () => { await signIn(pending); setPending(null); router.replace('/'); }} />;
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
      {deleted === '1' && <Text accessibilityRole="status" style={styles.subtitle}>账号已注销</Text>}
      <View style={{ flexDirection: 'row', backgroundColor: colors.paper, borderRadius: radius.md, padding: space.xs }}>
        {['登录', '注册'].map((label, index) => <Pressable key={label} disabled={busy} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: register === (index === 1), disabled: busy }} onPress={() => { setRegister(index === 1); setError(''); }} style={{ flex: 1, minHeight: layout.touch, justifyContent: 'center', borderRadius: radius.sm, padding: space.md, backgroundColor: register === (index === 1) ? colors.surface : 'transparent' }}><Text style={{ textAlign: 'center', fontWeight: '600', color: register === (index === 1) ? colors.ink : colors.muted }}>{label}</Text></Pressable>)}
      </View>
      <View style={{ gap: space.lg }}>
        {register && <Field label="怎么称呼你" placeholder="你的博主昵称（选填）" value={nickname} onChangeText={setNickname} autoComplete="nickname" />}
        <Field inputRef={usernameInput} label="用户名" placeholder="3–32 位用户名" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" />
        <Field label="密码" placeholder="至少 8 位" value={password} onChangeText={setPassword} secureTextEntry autoComplete={register ? 'new-password' : 'current-password'} onSubmitEditing={() => void submit()} />
        {!register && <Button title="忘记密码？" variant="ghost" onPress={() => router.push('/forgot')} />}
        {register && <LegalConsent agreed={agreed} onChange={setAgreed} />}
        {!!error && <Notice text={error} />}
        <Button title={register ? '创建账号，开始创作' : '登录，继续创作'} loading={busy} disabled={register && !agreed} onPress={() => void submit()} icon="arrow-forward" />
      </View>
      <LegalLinks />
      <Text style={{ color: colors.muted, ...type.caption, textAlign: 'center' }}>你的品牌合作灵感，都从这里开始</Text>
    </KeyboardAvoidingView>
  </Page>;
}
