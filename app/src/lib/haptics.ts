import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export function feedback(kind: 'selection' | 'success' | 'warning' = 'selection') {
  if (Platform.OS === 'web') return;
  const result = kind === 'selection' ? Haptics.selectionAsync() : Haptics.notificationAsync(
    kind === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
  );
  void result.catch(() => { /* 部分设备没有触感引擎，操作仍可继续。 */ });
}
