import { useEffect } from 'react';
import type { DimensionValue, StyleProp, ViewStyle } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { motion, radius } from '../../theme';
import { usePalette } from './ThemeProvider';

export interface SkeletonProps {
  /** 骨架占位附加样式。 */
  style?: StyleProp<ViewStyle>;
  /** 占位宽度。 */
  width?: DimensionValue;
  /** 占位高度。 */
  height?: DimensionValue;
}

export function Skeleton({ style, width, height }: SkeletonProps) {
  const palette = usePalette();
  const pulse = useSharedValue(0.55);
  const reduced = useReducedMotion();
  useEffect(() => { if (!reduced) pulse.value = withRepeat(withTiming(1, { duration: motion.pulse }), -1, true); return () => cancelAnimation(pulse); }, [pulse, reduced]);
  const animation = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <Animated.View accessible={false} style={[{ height: 16, borderRadius: radius.sm, backgroundColor: palette.placeholder }, width !== undefined && { width }, height !== undefined && { height }, style, animation]} />;
}
