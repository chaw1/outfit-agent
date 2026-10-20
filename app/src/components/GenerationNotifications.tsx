import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppState, Pressable, Text, View } from 'react-native';
import { useSession } from '../context/Session';
import type { Completion } from '../lib/completionTracker';
import { configureNotifications, listenNotificationTap, pollGenerations } from '../lib/notificationRuntime';
import { colors, layout, radius, space, type } from '../theme';

export function GenerationNotifications() {
  const { api, token, baseUrl, user, ready } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [noticeState, setNotice] = useState<{ scope: string; value: Completion }>();
  const userId = user?.id;
  const scope = JSON.stringify([baseUrl, userId]);
  const notice = noticeState?.scope === scope ? noticeState.value : undefined;
  const completed = useCallback((value: Completion) => { if (AppState.currentState === 'active' || !AppState.currentState) setNotice({ scope, value }); }, [scope]);
  useEffect(() => {
    if (!ready || (token && !userId)) return;
    void configureNotifications(token && userId ? { api, token, baseUrl, userId } : null, completed).catch(() => undefined);
    if (!token || !userId) return;
    const stop = listenNotificationTap(id => router.push({ pathname: '/projects/[id]', params: { id } }));
    const timer = setInterval(() => { void pollGenerations(); }, 3000);
    const subscription = AppState.addEventListener('change', () => { void pollGenerations(); });
    return () => { stop(); clearInterval(timer); subscription.remove(); };
  }, [api, token, baseUrl, userId, ready, router, completed]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice || !token) return null;
  return <View testID="generation-notice" style={{ position: 'absolute', top: insets.top + space.md, left: space.lg, right: space.lg, padding: space.lg, borderRadius: radius.md, backgroundColor: colors.blush, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', gap: space.md }}><Pressable accessibilityRole="button" accessibilityLabel="查看生成结果" style={{ flex: 1, minHeight: layout.touch }} onPress={() => { router.push({ pathname: '/projects/[id]', params: { id: notice.projectId } }); setNotice(undefined); }}><Text style={{ ...type.label, color: colors.ink }}>{notice.title}</Text><Text style={{ ...type.caption, color: colors.redText }}>{notice.body}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="关闭生成提示" onPress={() => setNotice(undefined)} style={({ pressed }) => ({ width: layout.touch, height: layout.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: pressed ? colors.surface : colors.blush })}><Ionicons name="close" size={20} color={colors.muted} /></Pressable></View>;
}
