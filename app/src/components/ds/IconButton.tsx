import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import { layout, radius } from '../../theme';
import { usePalette } from './ThemeProvider';

export interface IconButtonProps {
  /** 图标名称。 */
  name: keyof typeof Ionicons.glyphMap;
  /** 必填的无障碍名称。 */
  label: string;
  /** 点击图标时调用。 */
  onPress: () => void;
  /** 自动化或宿主定位该操作。 */
  testID?: string;
}

export function IconButton({ name, label, onPress, testID }: IconButtonProps) {
  const palette = usePalette();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={({ pressed }) => ({ width: layout.touch, height: layout.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: pressed ? palette.blush : palette.paper, transform: [{ scale: pressed ? 0.94 : 1 }] })}>
    <Ionicons name={name} size={21} color={palette.ink} />
  </Pressable>;
}
