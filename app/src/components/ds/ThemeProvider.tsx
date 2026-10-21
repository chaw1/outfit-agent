import { createContext, useContext, type ReactNode } from 'react';

import { colors, studio, type as typography } from '../../theme';

export type ThemeTone = 'paper' | 'studio';

export interface ThemeProviderProps {
  /** 当前组件树使用的色板；嵌套时继承外层。 */
  tone?: ThemeTone;
  /** 字号与行高倍率；默认 1，画廊提供 1.3。 */
  fontScale?: number;
  /** 共享主题的子组件。 */
  children: ReactNode;
}

const ThemeContext = createContext({ tone: 'paper' as ThemeTone, fontScale: 1 });
export function usePalette() {
  const { tone } = useContext(ThemeContext);
  return tone === 'studio' ? {
    ink: studio.ink, muted: studio.muted, border: studio.line, paper: studio.canvas,
    surface: studio.surface, blush: studio.softAccent, redText: studio.redText,
    danger: studio.danger, green: studio.green, successSoft: studio.successSoft, placeholder: studio.line,
    warning: studio.warning, warningSoft: studio.warningSoft,
  } : { ...colors, placeholder: colors.imagePlaceholder };
}

export function useTypography() {
  const { fontScale } = useContext(ThemeContext);
  if (fontScale === 1) return typography;
  return Object.fromEntries(Object.entries(typography).map(([key, value]) => [key, {
    ...value, fontSize: value.fontSize * fontScale, lineHeight: value.lineHeight * fontScale,
  }])) as typeof typography;
}

export function ThemeProvider({ tone, fontScale, children }: ThemeProviderProps) {
  const inherited = useContext(ThemeContext);
  return <ThemeContext.Provider value={{ tone: tone ?? inherited.tone, fontScale: fontScale ?? inherited.fontScale }}>{children}</ThemeContext.Provider>;
}
