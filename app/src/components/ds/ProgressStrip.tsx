import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { colors, motion, radius, space } from '../../theme';
import { usePalette, useTypography } from './ThemeProvider';

export interface ProgressStripProps {
  /** 当前进度标题，同时作为无障碍名称。 */
  title: string;
  /** 当前进度的附加说明。 */
  detail?: string;
}

export function ProgressStrip({ title, detail }: ProgressStripProps) {
  const palette = usePalette();
  const type = useTypography();
  const pulse = useSharedValue(0.4);
  const reduced = useReducedMotion();
  useEffect(() => { if (!reduced) pulse.value = withRepeat(withSequence(withTiming(1, { duration: motion.pulse }), withTiming(0.4, { duration: motion.pulse })), -1); return () => cancelAnimation(pulse); }, [pulse, reduced]);
  const animation = useAnimatedStyle(() => ({ opacity: pulse.value, transform: [{ scaleX: 0.7 + pulse.value * 0.3 }] }));
  return <View accessibilityRole="progressbar" accessibilityLabel={title} style={{ padding: space.lg, borderRadius: radius.md, backgroundColor: palette.paper, gap: space.sm }}><View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}><Ionicons name="sparkles-outline" size={18} color={palette.redText} /><Text style={{ ...type.label, color: palette.ink, flex: 1 }}>{title}</Text></View>{detail ? <Text style={{ ...type.caption, color: palette.muted }}>{detail}</Text> : null}<View style={{ height: 4, backgroundColor: palette.border, overflow: 'hidden', borderRadius: radius.sm }}><Animated.View style={[{ height: 4, backgroundColor: colors.red, borderRadius: radius.sm }, animation]} /></View></View>;
}
