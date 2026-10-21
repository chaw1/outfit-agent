import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { layout, motion, radius, space } from '../../theme';
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** 按下时轻微缩小再弹回，和 Button 同一套手感。 */
export function Chip({ label, selected = false, disabled = false, onPress }: ChipProps) {
  const palette = usePalette();
  const type = useTypography();
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return <AnimatedPressable accessibilityRole="checkbox" accessibilityLabel={label} aria-checked={selected} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    onPressIn={() => { setPressed(true); scale.set(withTiming(0.96, { duration: motion.fast })); }} onPressOut={() => { setPressed(false); scale.set(withTiming(1, { duration: motion.fast })); }}
    style={[pressStyle, { minHeight: layout.touch, minWidth: layout.touch, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: selected ? palette.redText : palette.border, backgroundColor: selected || pressed ? palette.blush : palette.paper, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }]}>
    <Text style={{ ...type.label, color: selected ? palette.redText : palette.ink }}>{label}</Text>
  </AnimatedPressable>;
}
