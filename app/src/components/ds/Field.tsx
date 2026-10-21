import type { ComponentRef, Ref } from 'react';
import { Text, TextInput, View, type TextInputProps } from 'react-native';

import { space } from '../../theme';
import { usePalette, useTypography } from './ThemeProvider';
import { styles } from './sharedStyles';

export interface FieldProps extends TextInputProps {
  /** 可见标签，同时作为输入框无障碍名称。 */
  label: string;
  /** 输入框引用，用于聚焦等操作。 */
  inputRef?: Ref<ComponentRef<typeof TextInput>>;
  /** 错误说明；提供时显示可恢复提示并标出错误边界。 */
  error?: string;
  /** 禁用输入；仍支持原生 editable 属性。 */
  disabled?: boolean;
  /** 设计评审固定展示聚焦轮廓；普通聚焦沿用平台默认表现。 */
  previewFocused?: boolean;
}

export function Field({ label, inputRef, error, disabled, previewFocused, ...props }: FieldProps) {
  const palette = usePalette();
  const type = useTypography();
  return <View><Text style={[styles.label, type.label, { color: palette.ink }]}>{label}</Text><TextInput ref={inputRef} accessibilityLabel={label} placeholderTextColor={palette.muted} {...props} editable={disabled ? false : props.editable} aria-disabled={disabled || props['aria-disabled']} accessibilityState={{ ...props.accessibilityState, disabled: disabled || props.editable === false || props.accessibilityState?.disabled }} accessibilityHint={error || props.accessibilityHint} style={[styles.input, type.body, { borderColor: palette.border, backgroundColor: palette.paper, color: palette.ink, outlineColor: palette.redText }, props.multiline && { minHeight: 112, textAlignVertical: 'top' }, previewFocused && { borderColor: palette.redText, outlineWidth: 2, outlineStyle: 'solid' }, error && { borderColor: palette.danger }, disabled && { opacity: 0.5 }, props.style]} />{error && <Text accessibilityRole="alert" style={{ ...type.caption, color: palette.danger, marginTop: space.xs }}>{error}</Text>}</View>;
}
