import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { layout, motion, radius } from '../../theme';
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** 按下时缩小并换底色，松手弹回；缩放走动画而不是硬切。 */
export function IconButton({ name, label, onPress, testID }: IconButtonProps) {
  const palette = usePalette();
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return <AnimatedPressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
    onPressIn={() => { setPressed(true); scale.set(withTiming(0.92, { duration: motion.fast })); }} onPressOut={() => { setPressed(false); scale.set(withTiming(1, { duration: motion.fast })); }}
    style={[pressStyle, { width: layout.touch, height: layout.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: pressed ? palette.blush : palette.paper }]}>
    <Ionicons name={name} size={21} color={palette.ink} />
  </AnimatedPressable>;
}
