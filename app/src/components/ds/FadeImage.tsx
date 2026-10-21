import type { ImageProps } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { motion } from '../../theme';

export interface FadeImageProps extends ImageProps {
  /** 图片样式，保留原有覆盖顺序。 */
  style?: ImageProps['style'];
  /** 图片加载完成后的回调。 */
  onLoad?: ImageProps['onLoad'];
}

export function FadeImage({ style, onLoad, ...props }: FadeImageProps) {
  const opacity = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.Image {...props} style={[style, animatedStyle]} onLoad={event => { opacity.set(withTiming(1, { duration: motion.normal })); onLoad?.(event); }} />;
}
