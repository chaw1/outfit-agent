import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { ScrollView, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { studio } from '../../theme';
import { ThemeProvider } from './ThemeProvider';
import { styles } from './sharedStyles';

export interface PageProps {
  /** 页面内容。 */
  children: ReactNode;
  /** 是否使用内置滚动容器，默认关闭。 */
  scroll?: boolean;
  /** 滚动容器的附加内容样式。 */
  contentStyle?: ViewStyle;
  /** 页面色板，默认 paper。 */
  tone?: 'paper' | 'studio';
}

export function Page({ children, scroll = false, contentStyle, tone = 'paper' }: PageProps) {
  return <ThemeProvider tone={tone}><SafeAreaView style={[styles.page, tone === 'studio' && { backgroundColor: studio.bg }]} edges={['top', 'bottom']}>
    <StatusBar style={tone === 'studio' ? 'light' : 'dark'} />
    {scroll ? <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, contentStyle]}>{children}</ScrollView> : children}
  </SafeAreaView></ThemeProvider>;
}
