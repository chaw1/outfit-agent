import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { space } from '../../theme';
import { IconButton } from './IconButton';
import { usePalette, useTypography } from './ThemeProvider';

export interface HeaderProps {
  /** 页头标题。 */
  title: string;
  /** 可选的说明文字。 */
  subtitle?: string;
  /** 提供时显示返回按钮。 */
  onBack?: () => void;
  /** 页头右侧的附加内容。 */
  right?: ReactNode;
}

export function Header({ title, subtitle, onBack, right }: HeaderProps) {
  const palette = usePalette();
  const type = useTypography();
  return <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, flexDirection: 'row', alignItems: 'center', gap: space.md, borderBottomWidth: 1, borderBottomColor: palette.border }}>
    {onBack && <IconButton name="arrow-back" label="返回" onPress={onBack} />}
    <View style={{ flex: 1 }}><Text numberOfLines={1} style={{ ...type.subtitle, color: palette.ink }}>{title}</Text>{subtitle && <Text numberOfLines={1} style={{ ...type.caption, color: palette.muted, marginTop: space.xs }}>{subtitle}</Text>}</View>
    {right}
  </View>;
}
