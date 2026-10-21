import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { FadeInDown, ReduceMotion, useReducedMotion } from 'react-native-reanimated';

import { motion } from '../../theme';

export interface AnimatedEntryProps {
  /** 需要入场动画的内容。 */
  children: ReactNode;
  /** 入场延迟毫秒数，最多为 240。 */
  delay?: number;
  /** 动画容器样式。 */
  style?: StyleProp<ViewStyle>;
}

export function AnimatedEntry({ children, delay = 0, style }: AnimatedEntryProps) {
  const reduced = useReducedMotion();
  return <Animated.View entering={reduced ? undefined : FadeInDown.duration(motion.normal).delay(Math.min(delay, 240)).reduceMotion(ReduceMotion.System)} style={style}>{children}</Animated.View>;
}
