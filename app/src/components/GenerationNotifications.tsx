import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useSession } from '../context/Session';
import type { Completion } from '../lib/completionTracker';
import { configureNotifications, listenNotificationTap, pollGenerations } from '../lib/notificationRuntime';
import { colors } from './ui';

export function GenerationNotifications() {
  const { api, token, baseUrl, user, ready } = useSession();
  const router = useRouter();
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
  return <View testID="generation-notice" style={{ position: 'absolute', top: 62, left: 18, right: 18, padding: 16, borderRadius: 16, backgroundColor: colors.blush, borderWidth: 1, borderColor: '#FFD5DC', flexDirection: 'row', gap: 12 }}><Pressable accessibilityRole="button" accessibilityLabel="查看生成结果" style={{ flex: 1 }} onPress={() => { router.push({ pathname: '/projects/[id]', params: { id: notice.projectId } }); setNotice(undefined); }}><Text style={{ fontWeight: '700', color: colors.ink }}>{notice.title}</Text><Text style={{ color: colors.red, lineHeight: 22 }}>{notice.body}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="关闭生成提示" onPress={() => setNotice(undefined)}><Text style={{ color: colors.muted }}>关闭</Text></Pressable></View>;
}
