import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useSegments } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Text, View } from 'react-native';
import { canEnterApp, hasPrivacyConsent, savePrivacyConsent, type PrivacyState } from '../lib/legalConsent';
import { radius, space, studio, type } from '../theme';
import { LegalLinks } from './LegalLinks';
import { Button, FadeImage, LoadingSkeleton, Notice, Page, errorText, usePalette } from './ui';

const COLLAGE_HEIGHT = 200;
const collage = [require('../../assets/inspiration/studio-04.jpg'), require('../../assets/inspiration/studio-07.jpg')];

function GateBody({ state, busy, error, onAccept, onDecline, onRead }: { state: PrivacyState; busy: boolean; error: string; onAccept: () => void; onDecline: () => void; onRead: () => void }) {
  const palette = usePalette();
  return <>
    <View style={{ flexDirection: 'row', gap: space.md, height: COLLAGE_HEIGHT }}>{collage.map((source, index) => <FadeImage key={index} source={source} style={{ flex: 1, height: COLLAGE_HEIGHT, borderRadius: radius.md, backgroundColor: studio.surface }} />)}</View>
    <View style={{ gap: space.sm }}>
      <Text style={{ ...type.badge, letterSpacing: 2, color: palette.muted }}>一件衣服，一组大片</Text>
      <Text accessibilityRole="header" style={{ ...type.title, color: palette.ink }}>{state === 'declined' ? '暂不使用衣序' : '隐私提示'}</Text>
    </View>
    <Text style={{ ...type.body, color: palette.muted }}>衣序（演示版）会处理你的账号、主动上传的照片与参考图、生成记录和必要设备日志，用于保存项目与生成内容。生成所需素材可能交由阿里云百炼、DeepSeek 处理。请先阅读用户协议与隐私政策，自主选择是否同意。</Text>
    <LegalLinks />
    <Button title="查看协议" variant="secondary" onPress={onRead} />
    {!!error && <Notice text={error} />}
    <Button title="同意并继续" loading={busy} onPress={onAccept} />
    {state === 'required' ? <Button title="暂不使用" variant="ghost" disabled={busy} onPress={onDecline} /> : <Text style={{ ...type.body, color: palette.muted }}>你尚未同意，暂时无法进入服务。可阅读协议后重新选择。</Text>}
  </>;
}

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
  return <Modal visible animationType="fade" onRequestClose={() => undefined}><View testID="privacy-gate" style={{ flex: 1, backgroundColor: studio.bg }}>
    {state === 'loading' ? <Page tone="studio"><LoadingSkeleton kind="list" /></Page> : <Page tone="studio" scroll contentStyle={{ flexGrow: 1, justifyContent: 'center', gap: space.xl }}>
      <GateBody state={state} busy={busy} error={error} onAccept={() => void accept()} onDecline={() => setState('declined')} onRead={() => router.push({ pathname: '/legal/[kind]', params: { kind: 'privacy' } })} />
    </Page>}
  </View></Modal>;
}
