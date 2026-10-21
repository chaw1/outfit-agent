import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { radius, space } from '../../theme';
import { AnimatedEntry } from './AnimatedEntry';
import { usePalette, useTypography } from './ThemeProvider';

export interface ToastProps {
  /** 临时提示内容。 */
  text: string;
  /** 提示语气，默认 success。 */
  tone?: 'success' | 'danger' | 'info';
  /** 六秒自动关闭时调用。 */
  onDismiss?: () => void;
  /** 自动关闭毫秒数，默认 6000；设为 0 持续展示。 */
  duration?: number;
  /** 自动化测试标识。 */
  testID?: string;
}

export function Toast({ text, tone = 'success', onDismiss, testID, duration = 6000 }: ToastProps) {
  const palette = usePalette();
  const type = useTypography();
  const [dismissedText, setDismissedText] = useState('');
  const dismiss = useRef(onDismiss);
  useEffect(() => { dismiss.current = onDismiss; }, [onDismiss]);
  useEffect(() => { if (duration <= 0) return; const timer = setTimeout(() => { setDismissedText(text); dismiss.current?.(); }, duration); return () => clearTimeout(timer); }, [text, duration]);
  if (!text || dismissedText === text) return null;
  const color = tone === 'danger' ? palette.danger : tone === 'success' ? palette.green : palette.ink;
  return <AnimatedEntry><View testID={testID} role={tone === 'danger' ? 'alert' : 'status'} accessibilityLiveRegion="polite" style={{ padding: space.md, borderRadius: radius.sm, backgroundColor: tone === 'danger' ? palette.blush : tone === 'success' ? palette.successSoft : palette.paper, flexDirection: 'row', alignItems: 'center', gap: space.sm }}><Ionicons name={tone === 'danger' ? 'alert-circle' : tone === 'success' ? 'checkmark-circle' : 'information-circle'} size={20} color={color} /><Text style={{ ...type.caption, color, flex: 1 }}>{text}</Text></View></AnimatedEntry>;
}
