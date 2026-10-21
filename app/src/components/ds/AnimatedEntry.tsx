import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { FadeInDown, FadeOut, LinearTransition, ReduceMotion, useReducedMotion } from 'react-native-reanimated';

import { motion } from '../../theme';

export interface AnimatedEntryProps {
  /** 需要入场动画的内容。 */
  children: ReactNode;
  /** 入场延迟毫秒数，最多为 240。 */
  delay?: number;
  /** 动画容器样式。 */
  style?: StyleProp<ViewStyle>;
  /** 列表项位置变化时平滑移动（筛选、删除、排序），默认关闭。 */
  reflow?: boolean;
  /** 卸载时淡出而不是直接消失，默认关闭。 */
  exit?: boolean;
}

export function AnimatedEntry({ children, delay = 0, style, reflow = false, exit = false }: AnimatedEntryProps) {
  const reduced = useReducedMotion();
  return <Animated.View
    entering={reduced ? undefined : FadeInDown.duration(motion.normal).delay(Math.min(delay, 240)).reduceMotion(ReduceMotion.System)}
    exiting={reduced || !exit ? undefined : FadeOut.duration(motion.fast).reduceMotion(ReduceMotion.System)}
    layout={reduced || !reflow ? undefined : LinearTransition.duration(motion.normal).reduceMotion(ReduceMotion.System)}
    style={style}>{children}</Animated.View>;
}
