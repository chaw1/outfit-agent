import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

import { studio } from '../../theme';

/**
 * 片场首屏的背景光：两团很淡的光晕（左上暖红、右中冷白）压在纯深色上，
 * 让深色不发闷、灵感图不像贴在黑板上。只是氛围，不接收点击。
 */
export function StudioGlow() {
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <Svg width="100%" height="100%" viewBox="0 0 390 900" preserveAspectRatio="xMidYMin slice">
      <Defs>
        <RadialGradient id="warm" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={studio.accent} stopOpacity={0.26} />
          <Stop offset="0.55" stopColor={studio.accent} stopOpacity={0.07} />
          <Stop offset="1" stopColor={studio.bg} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="cool" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={studio.ink} stopOpacity={0.08} />
          <Stop offset="1" stopColor={studio.bg} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx="40" cy="40" rx="300" ry="240" fill="url(#warm)" />
      <Ellipse cx="420" cy="420" rx="260" ry="320" fill="url(#cool)" />
    </Svg>
  </View>;
}
