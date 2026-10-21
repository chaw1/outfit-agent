import { Pressable, Text, View } from 'react-native';

import { layout, radius, space } from '../../theme';
import { usePalette, useTypography } from './ThemeProvider';

export interface SegmentOption<T extends string> {
  /** 稳定选项标识。 */
  value: T;
  /** 可见选项名称，同时作为无障碍名称。 */
  label: string;
  /** 是否禁止选择。 */
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  /** 分组的无障碍名称。 */
  label: string;
  /** 互斥选项。 */
  options: readonly SegmentOption<T>[];
  /** 当前选项。 */
  value: T;
  /** 切换选项时调用。 */
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ label, options, value, onChange }: SegmentedProps<T>) {
  const palette = usePalette();
  const type = useTypography();
  return <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: 'row', padding: space.xs, gap: space.xs, borderWidth: 1, borderColor: palette.border, borderRadius: radius.md, backgroundColor: palette.paper }}>{options.map(option => {
    const selected = option.value === value;
    return <Pressable key={option.value} accessibilityRole="tab" accessibilityLabel={option.label} aria-selected={selected} accessibilityState={{ selected, disabled: !!option.disabled }} disabled={option.disabled} onPress={() => onChange(option.value)} style={({ pressed }) => ({ flex: 1, minHeight: layout.touch, minWidth: layout.touch, paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.sm, justifyContent: 'center', alignItems: 'center', backgroundColor: selected ? palette.blush : pressed ? palette.surface : 'transparent', opacity: option.disabled ? 0.5 : 1 })}><Text style={{ ...type.label, color: selected ? palette.redText : palette.muted, textAlign: 'center' }}>{option.label}</Text></Pressable>;
  })}</View>;
}
