import { Ionicons } from '@expo/vector-icons';
import { Text, View } from 'react-native';

import { radius, space } from '../../theme';
import { Button } from './Button';
import { usePalette, useTypography } from './ThemeProvider';

export interface StatePanelProps {
  /** 状态语义；默认 empty。 */
  variant?: 'empty' | 'error' | 'offline';
  /** 状态图标名称。 */
  icon: keyof typeof Ionicons.glyphMap;
  /** 状态标题。 */
  title: string;
  /** 状态说明及恢复提示。 */
  description: string;
  /** 可选恢复操作的按钮文案。 */
  actionLabel?: string;
  /** 与 actionLabel 同时提供时显示按钮。 */
  onAction?: () => void;
}

export function StatePanel({ icon, title, description, actionLabel, onAction, variant = 'empty' }: StatePanelProps) {
  const palette = usePalette();
  const type = useTypography();
  const feedback = variant === 'error' ? palette.danger : variant === 'offline' ? palette.muted : palette.redText;
  return <View accessibilityRole={variant === 'error' ? 'alert' : undefined} style={{ padding: space.xl, backgroundColor: palette.paper, borderRadius: radius.lg, gap: space.lg, alignItems: 'center' }}><View style={{ width: 64, height: 64, borderRadius: radius.lg, backgroundColor: palette.blush, alignItems: 'center', justifyContent: 'center' }}><Ionicons name={icon} size={28} color={feedback} /></View><Text style={{ ...type.subtitle, color: palette.ink, textAlign: 'center' }}>{title}</Text><Text style={{ ...type.caption, color: palette.muted, textAlign: 'center' }}>{description}</Text>{actionLabel && onAction ? <Button title={actionLabel} variant="secondary" onPress={onAction} /> : null}</View>;
}
