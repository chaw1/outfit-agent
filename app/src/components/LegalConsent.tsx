import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import { space, type } from '../theme';
import { usePalette } from './ui';

export function LegalConsent({ agreed, onChange }: { agreed: boolean; onChange: (value: boolean) => void }) {
  const palette = usePalette();
  return <View style={{ gap: space.sm }}>
    <Pressable accessibilityRole="checkbox" accessibilityLabel="我已阅读并同意《用户协议》和《隐私政策》" accessibilityState={{ checked: agreed }} aria-checked={agreed} onPress={() => onChange(!agreed)} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: space.sm }}>
      <Ionicons name={agreed ? 'checkbox' : 'square-outline'} size={24} color={agreed ? palette.redText : palette.muted} />
      <Text style={{ ...type.body, color: palette.ink, flex: 1 }}>我已阅读并同意《用户协议》和《隐私政策》</Text>
    </Pressable>
    {!agreed && <Text style={{ ...type.caption, color: palette.muted }}>请先阅读并勾选同意，再创建账号。</Text>}
  </View>;
}
