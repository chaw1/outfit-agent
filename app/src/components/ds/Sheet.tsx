import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';

import { colors, layout, radius, space } from '../../theme';
import { IconButton } from './IconButton';
import { usePalette, useTypography } from './ThemeProvider';

export interface SheetProps {
  /** 弹层标题，同时作为无障碍名称。 */
  label: string;
  /** 弹层是否打开。 */
  visible: boolean;
  /** 关闭按钮、遮罩或系统返回触发。 */
  onClose: () => void;
  /** 弹层内容。 */
  children: ReactNode;
  /** 在组件画廊中内嵌同一份弹层表面。 */
  inline?: boolean;
  /** 内容与关闭操作的自动化定位，不改变无障碍名称。 */
  testID?: string;
  closeTestID?: string;
  /** 默认是“关闭 + 标题”。 */
  closeLabel?: string;
}

export function Sheet({ label, visible, onClose, children, inline = false, testID, closeTestID, closeLabel = `关闭${label}` }: SheetProps) {
  const palette = usePalette();
  const type = useTypography();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  if (!visible) return null;
  const surface = <View testID={testID} accessibilityViewIsModal={!inline} aria-modal={!inline} role="dialog" accessibilityLabel={label} style={{ width: '100%', maxWidth: layout.maxWidth, maxHeight: inline ? undefined : '90%', alignSelf: 'center', backgroundColor: palette.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.xl, paddingBottom: space.xl + insets.bottom, gap: space.lg }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}><Text style={{ ...type.subtitle, color: palette.ink, flex: 1 }}>{label}</Text><IconButton name="close" label={closeLabel} testID={closeTestID} onPress={onClose} /></View><ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.lg }}>{children}</ScrollView></View>;
  if (inline) return surface;
  return <Modal visible transparent animationType={reduced ? 'none' : 'slide'} onRequestClose={onClose}><View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay }}><Pressable accessibilityRole="button" accessibilityLabel={`${closeLabel}遮罩`} onPress={onClose} style={{ position: 'absolute', inset: 0 }} />{surface}</View></Modal>;
}
