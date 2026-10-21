import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { colors, space, type } from '../theme';

export function LegalConsent({ agreed, onChange }: { agreed: boolean; onChange: (value: boolean) => void }) {
  const router = useRouter();
  return <View style={{ gap: space.sm }}>
    <Pressable accessibilityRole="checkbox" accessibilityLabel="我已阅读并同意《用户协议》和《隐私政策》" accessibilityState={{ checked: agreed }} aria-checked={agreed} onPress={() => onChange(!agreed)} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: space.sm }}>
      <Ionicons name={agreed ? 'checkbox' : 'square-outline'} size={24} color={colors.redText} />
      <Text style={{ ...type.caption, color: colors.ink, flex: 1 }}>我已阅读并同意《用户协议》和《隐私政策》</Text>
    </Pressable>
    <View style={{ flexDirection: 'row', gap: space.lg }}>
      {(['terms', 'privacy'] as const).map(kind => <Pressable key={kind} accessibilityRole="link" accessibilityLabel={`阅读${kind === 'terms' ? '用户协议' : '隐私政策'}`} onPress={() => router.push({ pathname: '/legal/[kind]', params: { kind } })} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ ...type.caption, color: colors.redText, textDecorationLine: 'underline' }}>《{kind === 'terms' ? '用户协议' : '隐私政策'}》</Text></Pressable>)}
    </View>
    {!agreed && <Text style={{ ...type.caption, color: colors.muted }}>请先阅读并勾选同意，再创建账号。</Text>}
  </View>;
}
