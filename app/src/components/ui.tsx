import { Ionicons } from '@expo/vector-icons';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type ImageProps, type StyleProp, type TextInputProps, type ViewStyle, type DimensionValue } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, ReduceMotion, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { colors, layout, motion, radius, space, studio, type } from '../theme';

export { colors } from '../theme';
const ToneContext = createContext<'paper' | 'studio'>('paper');
function usePalette() {
  const tone = useContext(ToneContext);
  return tone === 'studio' ? {
    ink: studio.ink, muted: studio.muted, border: studio.line, paper: studio.canvas,
    surface: studio.surface, blush: studio.softAccent, redText: '#FF7084',
    danger: '#FF8B9B', green: '#9DCDB1', successSoft: '#1D3428', placeholder: studio.line,
  } : { ...colors, placeholder: colors.imagePlaceholder };
}
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface, width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center' },
  content: { padding: space.xl, paddingBottom: space.xxl, gap: space.xl },
  title: { ...type.title, color: colors.ink },
  subtitle: { ...type.body, color: colors.muted },
  label: { ...type.label, color: colors.ink, marginBottom: space.sm },
  input: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, borderRadius: radius.sm, paddingHorizontal: space.lg, paddingVertical: space.md, ...type.body, color: colors.ink, minHeight: 52, outlineColor: colors.redText },
  section: { ...type.heading, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
export function Page({ children, scroll = false, contentStyle, tone = 'paper' }: { children: React.ReactNode; scroll?: boolean; contentStyle?: ViewStyle; tone?: 'paper' | 'studio' }) {
  return <ToneContext.Provider value={tone}><SafeAreaView style={[styles.page, tone === 'studio' && { backgroundColor: studio.bg }]} edges={['top', 'bottom']}>
    <StatusBar style={tone === 'studio' ? 'light' : 'dark'} />
    {scroll ? <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, contentStyle]}>{children}</ScrollView> : children}
  </SafeAreaView></ToneContext.Provider>;
}
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export function Button({ title, onPress, loading, disabled, variant = 'primary', icon, testID }: {
  title: string; onPress: () => void; loading?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: keyof typeof Ionicons.glyphMap; testID?: string;
}) {
  const palette = usePalette();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const filled = variant === 'primary' || variant === 'danger';
  const foreground = filled ? colors.white : palette.redText;
  return <AnimatedPressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} testID={testID} onPress={onPress} disabled={disabled || loading}
    onPressIn={() => { scale.set(withTiming(0.975, { duration: motion.fast })); }} onPressOut={() => { scale.set(withTiming(1, { duration: motion.fast })); }}
    style={[{ outlineColor: palette.redText, minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: variant === 'primary' ? colors.action : variant === 'danger' ? colors.danger : variant === 'secondary' ? palette.blush : 'transparent', opacity: disabled || loading ? 0.5 : 1 }, animatedStyle]}>
    {loading ? <ActivityIndicator size="small" color={foreground} /> : icon ? <Ionicons name={icon} size={18} color={foreground} /> : null}
    <Text style={{ ...type.button, color: foreground, flexShrink: 1, textAlign: 'center' }}>{title}</Text>
  </AnimatedPressable>;
}
export function IconButton({ name, label, onPress }: { name: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  const palette = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={({ pressed }) => ({ width: layout.touch, height: layout.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: pressed ? palette.blush : palette.paper, transform: [{ scale: pressed ? 0.94 : 1 }] })}>
    <Ionicons name={name} size={21} color={palette.ink} />
  </Pressable>;
}
export function Header({ title, subtitle, onBack, right }: { title: string; subtitle?: string; onBack?: () => void; right?: React.ReactNode }) {
  const palette = usePalette();
  return <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, flexDirection: 'row', alignItems: 'center', gap: space.md, borderBottomWidth: 1, borderBottomColor: palette.border }}>
    {onBack && <IconButton name="arrow-back" label="返回" onPress={onBack} />}
    <View style={{ flex: 1 }}><Text numberOfLines={1} style={{ ...type.subtitle, color: palette.ink }}>{title}</Text>{subtitle && <Text numberOfLines={1} style={{ ...type.caption, color: palette.muted, marginTop: space.xs }}>{subtitle}</Text>}</View>
    {right}
  </View>;
}
export function Field({ label, inputRef, ...props }: TextInputProps & { label: string; inputRef?: React.Ref<React.ComponentRef<typeof TextInput>> }) {
  const palette = usePalette();
  return <View><Text style={[styles.label, { color: palette.ink }]}>{label}</Text><TextInput ref={inputRef} accessibilityLabel={label} placeholderTextColor={palette.muted} {...props} style={[styles.input, { borderColor: palette.border, backgroundColor: palette.paper, color: palette.ink, outlineColor: palette.redText }, props.multiline && { minHeight: 112, textAlignVertical: 'top' }, props.style]} /></View>;
}
export function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const palette = usePalette();
  return <View accessibilityRole="alert" style={{ backgroundColor: palette.blush, padding: space.lg, borderRadius: radius.sm, gap: space.sm }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}><Ionicons name="alert-circle-outline" color={palette.danger} size={20} /><Text style={{ color: palette.danger, ...type.caption, flex: 1 }}>{text}</Text></View>
    {onRetry && <Pressable accessibilityRole="button" accessibilityLabel="重试" onPress={onRetry} style={({ pressed }) => ({ minHeight: layout.touch, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.sm, backgroundColor: pressed ? palette.surface : palette.blush, alignSelf: 'flex-start' })}><Text style={{ color: palette.redText, ...type.label }}>重试</Text></Pressable>}
  </View>;
}
export function Toast({ text, tone = 'success', onDismiss, testID }: { text: string; tone?: 'success' | 'danger' | 'info'; onDismiss?: () => void; testID?: string }) {
  const palette = usePalette();
  const [dismissedText, setDismissedText] = useState('');
  const dismiss = useRef(onDismiss);
  useEffect(() => { dismiss.current = onDismiss; }, [onDismiss]);
  useEffect(() => { const timer = setTimeout(() => { setDismissedText(text); dismiss.current?.(); }, 6000); return () => clearTimeout(timer); }, [text]);
  if (!text || dismissedText === text) return null;
  const color = tone === 'danger' ? palette.danger : tone === 'success' ? palette.green : palette.ink;
  return <AnimatedEntry><View testID={testID} accessibilityRole={tone === 'danger' ? 'alert' : 'status'} accessibilityLiveRegion="polite" style={{ padding: space.md, borderRadius: radius.sm, backgroundColor: tone === 'danger' ? palette.blush : tone === 'success' ? palette.successSoft : palette.paper, flexDirection: 'row', alignItems: 'center', gap: space.sm }}><Ionicons name={tone === 'danger' ? 'alert-circle' : tone === 'success' ? 'checkmark-circle' : 'information-circle'} size={20} color={color} /><Text style={{ ...type.caption, color, flex: 1 }}>{text}</Text></View></AnimatedEntry>;
}
export function AnimatedEntry({ children, delay = 0, style }: { children: React.ReactNode; delay?: number; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  return <Animated.View entering={reduced ? undefined : FadeInDown.duration(motion.normal).delay(Math.min(delay, 240)).reduceMotion(ReduceMotion.System)} style={style}>{children}</Animated.View>;
}
export function FadeImage({ style, onLoad, ...props }: ImageProps) {
  const opacity = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.Image {...props} style={[style, animatedStyle]} onLoad={event => { opacity.set(withTiming(1, { duration: motion.normal })); onLoad?.(event); }} />;
}
export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'brand' | 'success' | 'danger' | 'inverse' }) {
  const palette = usePalette();
  const color = tone === 'inverse' ? colors.white : tone === 'brand' ? palette.redText : tone === 'success' ? palette.green : tone === 'danger' ? palette.danger : palette.muted;
  return <View style={{ alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, backgroundColor: tone === 'inverse' ? colors.viewerSurface : tone === 'brand' || tone === 'danger' ? palette.blush : tone === 'success' ? palette.successSoft : palette.paper }}><Text style={{ ...type.badge, color }}>{label}</Text></View>;
}
export function Skeleton({ style, width, height }: { style?: StyleProp<ViewStyle>; width?: DimensionValue; height?: DimensionValue }) {
  const palette = usePalette();
  const pulse = useSharedValue(0.55);
  const reduced = useReducedMotion();
  useEffect(() => { if (!reduced) pulse.value = withRepeat(withTiming(1, { duration: motion.pulse }), -1, true); return () => cancelAnimation(pulse); }, [pulse, reduced]);
  const animation = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <Animated.View accessible={false} style={[{ height: 16, borderRadius: radius.sm, backgroundColor: palette.placeholder }, width !== undefined && { width }, height !== undefined && { height }, style, animation]} />;
}
export function LoadingSkeleton({ kind = 'list' }: { kind?: 'list' | 'workspace' | 'note' }) {
  const { width } = useWindowDimensions();
  const coverHeight = (Math.min(width, layout.maxWidth) - space.lg * 2) / layout.thumbnailRatio;
  return <View accessibilityLabel="正在加载内容" accessibilityRole="progressbar" style={{ padding: space.lg, gap: space.xl }}>
    {kind === 'note' ? <><Skeleton style={{ width: '100%', height: coverHeight, borderRadius: radius.lg }} /><Skeleton style={{ width: '75%', height: 28 }} /><Skeleton /><Skeleton style={{ width: '85%' }} /></> : kind === 'workspace' ? <><Skeleton style={{ width: '65%', height: 48 }} /><Skeleton style={{ width: '90%', height: 100 }} /><Skeleton style={{ height: 240, borderRadius: radius.lg }} /></> : [0, 1].map(item => <View key={item} style={{ flexDirection: 'row', gap: space.lg }}><Skeleton style={{ width: 80, height: 104 }} /><View style={{ flex: 1, gap: space.md, paddingTop: space.sm }}><Skeleton style={{ width: '35%' }} /><Skeleton style={{ width: '90%', height: 24 }} /><Skeleton style={{ width: '65%' }} /></View></View>)}
  </View>;
}
export function ProgressStrip({ title, detail }: { title: string; detail?: string }) {
  const palette = usePalette();
  const pulse = useSharedValue(0.4);
  const reduced = useReducedMotion();
  useEffect(() => { if (!reduced) pulse.value = withRepeat(withSequence(withTiming(1, { duration: motion.pulse }), withTiming(0.4, { duration: motion.pulse })), -1); return () => cancelAnimation(pulse); }, [pulse, reduced]);
  const animation = useAnimatedStyle(() => ({ opacity: pulse.value, transform: [{ scaleX: 0.7 + pulse.value * 0.3 }] }));
  return <View accessibilityRole="progressbar" accessibilityLabel={title} style={{ padding: space.lg, borderRadius: radius.md, backgroundColor: palette.paper, gap: space.sm }}><View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}><Ionicons name="sparkles-outline" size={18} color={palette.redText} /><Text style={{ ...type.label, color: palette.ink, flex: 1 }}>{title}</Text></View>{detail ? <Text style={{ ...type.caption, color: palette.muted }}>{detail}</Text> : null}<View style={{ height: 4, backgroundColor: palette.border, overflow: 'hidden', borderRadius: radius.sm }}><Animated.View style={[{ height: 4, backgroundColor: colors.red, borderRadius: radius.sm }, animation]} /></View></View>;
}
export function StatePanel({ icon, title, description, actionLabel, onAction }: { icon: keyof typeof Ionicons.glyphMap; title: string; description: string; actionLabel?: string; onAction?: () => void }) {
  const palette = usePalette();
  return <View style={{ padding: space.xl, backgroundColor: palette.paper, borderRadius: radius.lg, gap: space.lg, alignItems: 'center' }}><View style={{ width: 64, height: 64, borderRadius: radius.lg, backgroundColor: palette.blush, alignItems: 'center', justifyContent: 'center' }}><Ionicons name={icon} size={28} color={palette.redText} /></View><Text style={{ ...type.subtitle, color: palette.ink, textAlign: 'center' }}>{title}</Text><Text style={{ ...type.caption, color: palette.muted, textAlign: 'center' }}>{description}</Text>{actionLabel && onAction ? <Button title={actionLabel} variant="secondary" onPress={onAction} /> : null}</View>;
}
export function Loading({ text = '稍等一下…' }: { text?: string }) {
  return <View style={{ padding: space.xl }}><ProgressStrip title={text} /></View>;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : '连接有点问题，请稍后重试。'; }
export const stageNames: Record<string, string> = { brief: '整理需求', direction: '选择方向', script: '打磨脚本', images: '挑选图片', note: '笔记就绪', video: '制作视频', done: '已完成' };
