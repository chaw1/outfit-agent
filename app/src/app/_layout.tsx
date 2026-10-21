import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SessionProvider, useSession } from '../context/Session';
import { LoadingSkeleton, colors } from '../components/ui';
import { Onboarding } from '../components/Onboarding';
import { GenerationNotifications } from '../components/GenerationNotifications';

function Routes() {
  const { ready, token } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const previousToken = useRef(token);
  useEffect(() => {
    if (!ready) return;
    const expired = !!previousToken.current && !token && !['settings', 'login'].includes(segments[0] ?? '');
    previousToken.current = token;
    const isPublic = segments[0] === 'login' || segments[0] === 'settings' || segments[0] === 'about' || segments[0] === 'legal';
    if (!token && !isPublic) router.replace(expired ? { pathname: '/login', params: { expired: '1' } } : '/login');
    else if (token && segments[0] === 'login') router.replace('/');
  }, [ready, token, segments, router]);
  return <View style={{ flex: 1, backgroundColor: colors.paper }}>
    <StatusBar style="dark" />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper }, animation: 'slide_from_right' }} />
    {ready && <><GenerationNotifications /><Onboarding /></>}
    {!ready && <View style={{ position: 'absolute', inset: 0, backgroundColor: colors.paper, justifyContent: 'center' }}><LoadingSkeleton kind="list" /></View>}
  </View>;
}

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><SessionProvider><Routes /></SessionProvider></SafeAreaProvider></GestureHandlerRootView>;
}
