import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, Text } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { colors, layout, motion, radius, space } from '../../theme';
import { usePalette, useTypography } from './ThemeProvider';

export interface ButtonProps {
  /** 可见按钮文案，同时作为无障碍名称。 */
  title: string;
  /** 点击按钮时调用。 */
  onPress: () => void;
  /** 显示加载指示器并禁止交互。 */
  loading?: boolean;
  /** 禁用按钮。 */
  disabled?: boolean;
  /** 按钮变体，默认 primary。 */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** 按钮前置图标。 */
  icon?: keyof typeof Ionicons.glyphMap;
  /** 设计评审时固定展示按下态；普通交互无需设置。 */
  previewPressed?: boolean;
  /** 自动化测试标识。 */
  testID?: string;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function Button({ title, onPress, loading, disabled, variant = 'primary', icon, testID, previewPressed }: ButtonProps) {
  const palette = usePalette();
  const type = useTypography();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: previewPressed ? 0.975 : scale.value }] }));
  const filled = variant === 'primary' || variant === 'danger';
  const foreground = filled ? colors.white : palette.redText;
  return <AnimatedPressable accessibilityRole="button" accessibilityLabel={title} aria-busy={!!loading} accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} testID={testID} onPress={onPress} disabled={disabled || loading}
    onPressIn={() => { scale.set(withTiming(0.975, { duration: motion.fast })); }} onPressOut={() => { scale.set(withTiming(1, { duration: motion.fast })); }}
    style={[{ outlineColor: palette.redText, minHeight: 52, minWidth: layout.touch, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: variant === 'primary' ? colors.action : variant === 'danger' ? colors.danger : variant === 'secondary' ? palette.blush : 'transparent', opacity: disabled || loading ? 0.5 : 1 }, animatedStyle]}>
    {loading ? <ActivityIndicator size="small" color={foreground} /> : icon ? <Ionicons name={icon} size={18} color={foreground} /> : null}
    <Text style={{ ...type.button, color: foreground, flexShrink: 1, textAlign: 'center' }}>{title}</Text>
  </AnimatedPressable>;
}
