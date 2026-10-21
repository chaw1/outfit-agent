import { Text, View } from 'react-native';

import { colors, radius, space } from '../../theme';
import { usePalette, useTypography } from './ThemeProvider';

export interface BadgeProps {
  /** 徽标文案。 */
  label: string;
  /** 徽标语气，默认 neutral。 */
  tone?: 'neutral' | 'brand' | 'success' | 'danger' | 'inverse' | 'warning';
}

export function Badge({ label, tone = 'neutral' }: BadgeProps) {
  const palette = usePalette();
  const type = useTypography();
  const color = tone === 'warning' ? palette.warning : tone === 'inverse' ? colors.white : tone === 'brand' ? palette.redText : tone === 'success' ? palette.green : tone === 'danger' ? palette.danger : palette.muted;
  return <View style={{ alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, backgroundColor: tone === 'warning' ? palette.warningSoft : tone === 'inverse' ? colors.viewerSurface : tone === 'brand' || tone === 'danger' ? palette.blush : tone === 'success' ? palette.successSoft : palette.paper }}><Text style={{ ...type.badge, color }}>{label}</Text></View>;
}
