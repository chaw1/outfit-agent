import { Pressable, Text } from 'react-native';

import { layout, radius, space } from '../../theme';
import { usePalette, useTypography } from './ThemeProvider';

export interface ChipProps {
  /** 风格词条，同时作为无障碍名称。 */
  label: string;
  /** 是否已选中。 */
  selected?: boolean;
  /** 是否暂时不可选择。 */
  disabled?: boolean;
  /** 选择或取消词条时调用。 */
  onPress: () => void;
}

export function Chip({ label, selected = false, disabled = false, onPress }: ChipProps) {
  const palette = usePalette();
  const type = useTypography();
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} aria-checked={selected} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: layout.touch, minWidth: layout.touch, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: selected ? palette.redText : palette.border, backgroundColor: selected || pressed ? palette.blush : palette.paper, justifyContent: 'center', opacity: disabled ? 0.5 : 1 })}><Text style={{ ...type.label, color: selected ? palette.redText : palette.ink }}>{label}</Text></Pressable>;
}
