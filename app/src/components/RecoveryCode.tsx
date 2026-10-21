import * as Clipboard from 'expo-clipboard';
import { usePreventRemove } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { isRecoveryCode } from '../lib/recoveryCode';
import { colors, radius, space, type } from '../theme';
import { Button, Notice, Page, errorText, styles } from './ui';

export function RecoveryCode({ code, onSaved, renewed = false }: { code: string; onSaved: () => Promise<void>; renewed?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const disablePrevention = usePreventRemove(!leaving, () => setError('请先安全保存恢复码，再点“我已保存”。'));
  async function copy() {
    setError('');
    try {
      const success = await Clipboard.setStringAsync(code);
      if (!success) throw new Error('复制失败，请手动安全保存恢复码。');
      setCopied(true);
    } catch (e) { setError(errorText(e)); }
  }
  async function save() {
    setBusy(true); setError('');
    setLeaving(true); disablePrevention();
    try { await onSaved(); } catch (e) { setLeaving(false); setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Page scroll contentStyle={{ flexGrow: 1, justifyContent: 'center', gap: space.xl }}>
    <Text accessibilityRole="header" style={styles.title}>{renewed ? '保存新的恢复码' : '保存你的恢复码'}</Text>
    <Text style={styles.subtitle}>恢复码是忘记密码后唯一的找回方式，只在这次展示。请保存到安全的地方，不要分享给任何人。{renewed ? '旧恢复码已作废，请替换你保存的旧码。' : '丢失密码和恢复码后，将无法找回账号。'}</Text>
    <View style={{ padding: space.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}><Text testID="recovery-code" selectable style={{ ...type.subtitle, textAlign: 'center', color: colors.ink, letterSpacing: 2 }}>{code}</Text></View>
    {!!error && <Notice text={error} />}
    <Button title={copied ? '已复制，再次复制' : '复制恢复码'} variant="secondary" onPress={() => void copy()} />
    {copied && <Text accessibilityRole="status" style={styles.subtitle}>恢复码已复制，请妥善保存。</Text>}
    <Button title="我已保存" loading={busy} disabled={!isRecoveryCode(code)} onPress={() => void save()} />
  </Page>;
}
