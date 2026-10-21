import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { layout, radius, space } from '../../theme';
import { usePalette, useTypography } from './ThemeProvider';

export interface NoticeProps {
  /** 需要告知用户的错误或提示内容。 */
  text: string;
  /** 提供时显示重试操作。 */
  onRetry?: () => void;
}

export function Notice({ text, onRetry }: NoticeProps) {
  const palette = usePalette();
  const type = useTypography();
  return <View accessibilityRole="alert" style={{ backgroundColor: palette.blush, padding: space.lg, borderRadius: radius.sm, gap: space.sm }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}><Ionicons name="alert-circle-outline" color={palette.danger} size={20} /><Text style={{ color: palette.danger, ...type.caption, flex: 1 }}>{text}</Text></View>
    {onRetry && <Pressable accessibilityRole="button" accessibilityLabel="重试" onPress={onRetry} style={({ pressed }) => ({ minHeight: layout.touch, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.sm, backgroundColor: pressed ? palette.surface : palette.blush, alignSelf: 'flex-start' })}><Text style={{ color: palette.redText, ...type.label }}>重试</Text></Pressable>}
  </View>;
}
