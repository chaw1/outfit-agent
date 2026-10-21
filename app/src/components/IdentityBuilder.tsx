import { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../context/Session';
import { loadLibraryModels, useLibraryModels } from '../lib/assets';
import { identityIsPending, modelStatusText, type IdentityInput, type IdentityQuote, type ModelCard } from '../lib/models';
import { formatPoints } from '../lib/transparency';
import { colors, layout, radius, space, type } from '../theme';
import { Button, Notice, ProgressStrip, errorText } from './ui';

export function IdentityBuilder({ assetIds, name }: { assetIds: string[]; name: string }) {
  const { api, token, baseUrl, isCurrentSession } = useSession();
  const library = useLibraryModels();
  const [quote, setQuote] = useState<{ input: IdentityInput; value: IdentityQuote }>();
  const [model, setModel] = useState<ModelCard>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const mounted = useRef(true);
  const request = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = model || library.identities?.find(item => item.face_asset_id === assetIds[0] && identityIsPending(item.status));
  const modelId = pending?.id;
  const status = pending?.status;
  useEffect(() => {
    if (!modelId || !identityIsPending(status)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const page = await api.myModels();
        if (!active || !isCurrentSession(token, baseUrl)) return;
        const updated = page.items.find(item => item.id === modelId);
        if (!updated) { setPollError('这张身份卡已不存在，请刷新我的模特。'); return; }
        setModel(updated); setPollError('');
        if (!identityIsPending(updated.status)) { void loadLibraryModels(api, true); return; }
      } catch (failure) {
        if (!active || !isCurrentSession(token, baseUrl)) return;
        setPollError(`进度暂时没取到，将继续刷新：${errorText(failure)}`);
      }
      if (active) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [api, baseUrl, isCurrentSession, modelId, status, token]);

  async function estimate() {
    if (request.current || !assetIds.length) return;
    request.current = true; setBusy(true); setError('');
    try {
      // One unambiguous front portrait is enough. The other profile photos may
      // have arbitrary angles; generation supplies the three labeled views.
      const input = { asset_ids: assetIds.slice(0, 1), name: `${name.trim() || '我的'} · 身份卡` };
      const value = await api.quoteIdentity(input);
      if (mounted.current && isCurrentSession(token, baseUrl)) setQuote({ input, value });
    } catch (failure) { if (mounted.current && isCurrentSession(token, baseUrl)) setError(errorText(failure)); }
    finally { request.current = false; if (mounted.current) setBusy(false); }
  }
  async function confirm() {
    if (!quote || request.current) return;
    request.current = true; setBusy(true); setError('');
    try {
      const created = await api.createIdentity({ ...quote.input, confirmation_token: quote.value.confirmation_token });
      if (!mounted.current || !isCurrentSession(token, baseUrl)) return;
      setModel(created); setQuote(undefined);
      void loadLibraryModels(api, true);
    } catch (failure) { if (mounted.current && isCurrentSession(token, baseUrl)) setError(errorText(failure)); }
    finally { request.current = false; if (mounted.current) setBusy(false); }
  }
  return <View style={local.group}>
    <Text style={local.title}>为本人建立身份卡</Text>
    <Text style={local.body}>用第一张本人照片作为正脸参考，补齐全身、侧身与半身，并保存人物描述。请先把清晰正脸设为默认；补齐 3 张图会使用点数。</Text>
    <Button title={busy && !quote ? '正在预估点数…' : pending?.status === 'failed' ? '重新建身份卡' : '建身份卡'} testID="build-identity" variant="secondary" disabled={busy || !assetIds.length || identityIsPending(status)} onPress={() => void estimate()} />
    {!assetIds.length && <Text style={local.body}>先添加一张本人照片，就能建立身份卡。</Text>}
    {pending && <View testID="identity-progress" accessibilityRole="status" style={local.group}>
      {identityIsPending(status) ? <ProgressStrip title={modelStatusText(pending)} detail={`已准备 ${pending.sheet_asset_ids.length}/4 个角度，可离开此页，完成后在我的模特里选择。`} /> : <Text style={local.body}>{pending.status === 'ready' ? '身份卡完成，已加入我的模特。' : pending.error || modelStatusText(pending)}</Text>}
    </View>}
    {!!pollError && <Notice text={pollError} />}
    {!!error && !quote && <Notice text={error} />}
    <Modal visible={!!quote} transparent animationType="fade" onRequestClose={() => { if (!busy) setQuote(undefined); }}>
      <View style={local.shade}><View accessibilityViewIsModal testID="identity-confirmation" style={local.dialog}>
        <Text style={local.title}>确认建立身份卡</Text>
        <Text style={local.body}>补齐 {quote?.value.generated_count} 个角度，预估上限 {formatPoints(quote?.value.estimate_points || 0)}。每张图片按现有规则计费，看图描述按实际用量计费。</Text>
        {quote?.value.breakdown.map(item => <Text key={item.label} style={local.body}>{item.label} · {formatPoints(item.points)}</Text>)}
        {!!error && <Notice text={error} />}
        <Button title="确认点数并建卡" testID="confirm-identity" loading={busy} onPress={() => void confirm()} />
        <Button title="暂不建卡" variant="ghost" disabled={busy} onPress={() => { setQuote(undefined); setError(''); }} />
      </View></View>
    </Modal>
  </View>;
}
const local = StyleSheet.create({
  group: { gap: space.md },
  title: { ...type.label, color: colors.ink },
  body: { ...type.body, color: colors.muted },
  shade: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.overlay },
  dialog: { width: '100%', maxWidth: layout.maxWidth, gap: space.lg, padding: space.xl, borderRadius: radius.lg, backgroundColor: colors.surface },
});
