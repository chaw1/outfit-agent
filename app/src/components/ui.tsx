import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colors = { ink: '#252522', muted: '#85847E', red: '#FF2442', border: '#EDECE7', paper: '#FCFAF7', blush: '#FFF0F2', green: '#39745B' };
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFFFFF', width: '100%', maxWidth: 520, alignSelf: 'center' },
  content: { padding: 24, paddingBottom: 36, gap: 22 },
  title: { fontSize: 28, fontWeight: '700', color: colors.ink, letterSpacing: -0.8 },
  subtitle: { fontSize: 14, lineHeight: 22, color: colors.muted },
  label: { fontSize: 13, color: colors.ink, fontWeight: '600', marginBottom: 10 },
  input: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 15, fontSize: 15, color: colors.ink, minHeight: 52 },
  section: { fontSize: 19, fontWeight: '700', color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});

export function Page({ children, scroll = false, contentStyle }: { children: React.ReactNode; scroll?: boolean; contentStyle?: ViewStyle }) {
  return <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
    {scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, contentStyle]}>{children}</ScrollView> : children}
  </SafeAreaView>;
}

export function Button({ title, onPress, loading, disabled, variant = 'primary', icon, testID }: {
  title: string; onPress: () => void; loading?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost'; icon?: keyof typeof Ionicons.glyphMap; testID?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} testID={testID} onPress={onPress} disabled={disabled || loading}
    style={({ pressed }) => [{ minHeight: 50, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 14, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: variant === 'primary' ? colors.red : variant === 'secondary' ? colors.blush : 'transparent', opacity: disabled || loading ? 0.5 : pressed ? 0.75 : 1 }]}>
    {loading ? <ActivityIndicator size="small" color={variant === 'primary' ? 'white' : colors.red} /> : icon ? <Ionicons name={icon} size={18} color={variant === 'primary' ? 'white' : colors.red} /> : null}
    <Text style={{ fontSize: 15, fontWeight: '600', color: variant === 'primary' ? 'white' : colors.red }}>{title}</Text>
  </Pressable>;
}

export function IconButton({ name, label, onPress }: { name: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: colors.paper }}>
    <Ionicons name={name} size={21} color={colors.ink} />
  </Pressable>;
}

export function Header({ title, subtitle, onBack, right }: { title: string; subtitle?: string; onBack?: () => void; right?: React.ReactNode }) {
  return <View style={{ paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    {onBack && <IconButton name="arrow-back" label="返回" onPress={onBack} />}
    <View style={{ flex: 1 }}><Text numberOfLines={1} style={{ fontSize: 17, fontWeight: '700', color: colors.ink }}>{title}</Text>{subtitle && <Text numberOfLines={1} style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>{subtitle}</Text>}</View>
    {right}
  </View>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor="#A4A39C" {...props} style={[styles.input, props.multiline && { minHeight: 110, textAlignVertical: 'top' }, props.style]} /></View>;
}

export function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return <View accessibilityRole="alert" style={{ backgroundColor: colors.blush, padding: 14, borderRadius: 12, gap: 8 }}><Text style={{ color: '#AE2940', fontSize: 13, lineHeight: 20 }}>{text}</Text>{onRetry && <Pressable accessibilityRole="button" onPress={onRetry}><Text style={{ color: colors.red, fontWeight: '700' }}>重试</Text></Pressable>}</View>;
}

export function Loading({ text = '稍等一下…' }: { text?: string }) {
  return <View style={{ padding: 36, alignItems: 'center', gap: 14 }}><ActivityIndicator color={colors.red} /><Text style={styles.subtitle}>{text}</Text></View>;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '连接有点问题，请稍后重试。';
}

export const stageNames: Record<string, string> = { brief: '整理需求', direction: '选择方向', script: '打磨脚本', images: '挑选图片', note: '笔记就绪', video: '制作视频', done: '已完成' };
