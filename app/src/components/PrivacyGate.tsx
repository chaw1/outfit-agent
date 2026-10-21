import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useSegments } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Text, View } from 'react-native';
import { canEnterApp, hasPrivacyConsent, savePrivacyConsent, type PrivacyState } from '../lib/legalConsent';
import { colors, space } from '../theme';
import { LegalLinks } from './LegalLinks';
import { Button, LoadingSkeleton, Notice, Page, errorText, styles } from './ui';

export function PrivacyGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PrivacyState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    void hasPrivacyConsent(AsyncStorage).then(agreed => { if (alive) setState(agreed ? 'accepted' : 'required'); });
    return () => { alive = false; };
  }, []);
  async function accept() {
    setBusy(true); setError('');
    try { await savePrivacyConsent(AsyncStorage); setState('accepted'); }
    catch (e) { setError(`无法保存隐私同意，请重试。${errorText(e)}`); }
    finally { setBusy(false); }
  }
  if (canEnterApp(state)) return children;
  if (segments[0] === 'legal') return null;
  return <Modal visible animationType="fade" onRequestClose={() => undefined}><View testID="privacy-gate" style={{ flex: 1, backgroundColor: colors.paper }}>
    {state === 'loading' ? <LoadingSkeleton kind="list" /> : <Page scroll contentStyle={{ flexGrow: 1, justifyContent: 'center', gap: space.xl }}>
      <Text accessibilityRole="header" style={styles.title}>{state === 'declined' ? '暂不使用衣序' : '隐私提示'}</Text>
      <Text style={styles.subtitle}>衣序（演示版）会处理你的账号、主动上传的照片与参考图、生成记录和必要设备日志，用于保存项目与生成内容。生成所需素材可能交由阿里云百炼、DeepSeek 处理。请先阅读用户协议与隐私政策，自主选择是否同意。</Text>
      <LegalLinks />
      <Button title="查看协议" variant="secondary" onPress={() => router.push({ pathname: '/legal/[kind]', params: { kind: 'privacy' } })} />
      {!!error && <Notice text={error} />}
      <Button title="同意并继续" loading={busy} onPress={() => void accept()} />
      {state === 'required' ? <Button title="暂不使用" variant="ghost" disabled={busy} onPress={() => setState('declined')} /> : <Text style={styles.subtitle}>你尚未同意，暂时无法进入服务。可阅读协议后重新选择。</Text>}
    </Page>}
  </View></Modal>;
}
