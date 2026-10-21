import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, space } from '../../theme';
import { usePalette } from './ThemeProvider';

export interface CardProps {
  /** 卡片内容；信息顺序由业务决定。 */
  children: ReactNode;
  /** 标准表面或较弱的内嵌表面。 */
  variant?: 'surface' | 'inset';
  /** 附加布局样式。 */
  style?: StyleProp<ViewStyle>;
}

export function Card({ children, variant = 'surface', style }: CardProps) {
  const palette = usePalette();
  return <View style={[{ padding: space.lg, gap: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.border, backgroundColor: variant === 'surface' ? palette.surface : palette.paper, overflow: 'hidden' }, style]}>{children}</View>;
}
