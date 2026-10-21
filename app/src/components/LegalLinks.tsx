import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import type { LegalKind } from '../api/types';
import { space, type } from '../theme';
import { usePalette } from './ui';

export const legalTitles: Record<LegalKind, string> = { terms: '用户协议', privacy: '隐私政策', disclaimer: 'AI 内容免责声明' };

export function LegalLinks() {
  const router = useRouter();
  const palette = usePalette();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm }}>
    {(Object.keys(legalTitles) as LegalKind[]).map(kind => <Pressable key={kind} accessibilityRole="link" accessibilityLabel={legalTitles[kind]} onPress={() => router.push({ pathname: '/legal/[kind]', params: { kind } })} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm }}>
      <Text style={{ ...type.caption, color: palette.redText, textDecorationLine: 'underline' }}>{legalTitles[kind]}</Text>
    </Pressable>)}
  </View>;
}
