import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SessionProvider, useSession } from '../context/Session';
import { studio } from '../theme';
import { LoadingSkeleton, colors } from '../components/ui';
import { Onboarding } from '../components/Onboarding';
import { PrivacyGate } from '../components/PrivacyGate';
import { GenerationNotifications } from '../components/GenerationNotifications';

function Routes() {
  const { ready, token, signOutReason } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const previousToken = useRef(token);
  useEffect(() => {
    if (!ready) return;
    const expired = !!previousToken.current && !token && !['settings', 'login'].includes(segments[0] ?? '');
    previousToken.current = token;
    const isPublic = segments[0] === 'login' || segments[0] === 'settings' || segments[0] === 'about' || segments[0] === 'legal' || segments[0] === 'forgot';
    if (!token && !isPublic) router.replace(signOutReason === 'deleted' ? { pathname: '/login', params: { deleted: '1' } } : expired ? { pathname: '/login', params: { expired: '1' } } : '/login');
    else if (token && segments[0] === 'login') router.replace('/');
  }, [ready, token, signOutReason, segments, router]);
  const dark = segments[0] === 'login' || segments[0] === 'assets' || !segments[0] || (segments[0] === 'projects' && segments[1] === 'new');
  return <View style={{ flex: 1, backgroundColor: dark ? studio.bg : colors.paper }}>
    <StatusBar style={dark ? "light" : "dark"} />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper }, animation: 'slide_from_right' }} />
    {ready && <PrivacyGate><GenerationNotifications /><Onboarding /></PrivacyGate>}
    {!ready && <View style={{ position: 'absolute', inset: 0, backgroundColor: colors.paper, justifyContent: 'center' }}><LoadingSkeleton kind="list" /></View>}
  </View>;
}

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><SessionProvider><Routes /></SessionProvider></SafeAreaProvider></GestureHandlerRootView>;
}
