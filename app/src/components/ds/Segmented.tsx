import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { layout, motion, radius, space } from '../../theme';
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
  /** 给每个选项一个自动化定位标识，不改变无障碍名称。 */
  optionTestID?: (value: T) => string;
}

/** 选中态是一枚会滑动的底片：切换时从旧位置平移到新位置，而不是两边颜色硬切。 */
export function Segmented<T extends string>({ label, options, value, onChange, optionTestID }: SegmentedProps<T>) {
  const palette = usePalette();
  const type = useTypography();
  const reduced = useReducedMotion();
  const [frames, setFrames] = useState<Partial<Record<T, { x: number; width: number }>>>({});
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const shown = useSharedValue(0);
  const frame = frames[value];
  useEffect(() => {
    if (!frame) return;
    const duration = reduced || !shown.get() ? 0 : motion.normal;
    x.set(withTiming(frame.x, { duration }));
    width.set(withTiming(frame.width, { duration }));
    shown.set(1);
  }, [frame, reduced, shown, width, x]);
  const pill = useAnimatedStyle(() => ({ width: width.get(), opacity: shown.get(), transform: [{ translateX: x.get() }] }));
  return <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: 'row', padding: space.xs, gap: space.xs, borderWidth: 1, borderColor: palette.border, borderRadius: radius.md, backgroundColor: palette.paper }}>
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: space.xs, bottom: space.xs, left: 0, borderRadius: radius.sm, backgroundColor: palette.blush }, pill]} />
    {options.map(option => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityLabel={option.label} aria-selected={selected} accessibilityState={{ selected, disabled: !!option.disabled }} disabled={option.disabled} testID={optionTestID?.(option.value)} onPress={() => onChange(option.value)}
        onLayout={event => { const { x: left, width: size } = event.nativeEvent.layout; setFrames(previous => previous[option.value]?.x === left && previous[option.value]?.width === size ? previous : { ...previous, [option.value]: { x: left, width: size } }); }}
        style={({ pressed }) => ({ flex: 1, minHeight: layout.touch, minWidth: layout.touch, paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.sm, justifyContent: 'center', alignItems: 'center', backgroundColor: pressed && !selected ? palette.surface : 'transparent', opacity: option.disabled ? 0.5 : 1 })}>
        <Text style={{ ...type.label, color: selected ? palette.redText : palette.muted, textAlign: 'center' }}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}
