import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SessionProvider, useSession } from '../context/Session';
import { Loading, colors } from '../components/ui';

function Routes() {
  const { ready, token } = useSession();
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    const isPublic = segments[0] === 'login' || segments[0] === 'settings';
    if (!token && !isPublic) router.replace('/login');
    else if (token && segments[0] === 'login') router.replace('/');
  }, [ready, token, segments, router]);
  return <View style={{ flex: 1, backgroundColor: colors.paper }}>
    <StatusBar style="dark" />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper }, animation: 'slide_from_right' }} />
    {!ready && <View style={{ position: 'absolute', inset: 0, backgroundColor: 'white', justifyContent: 'center' }}><Loading text="正在打开衣序…" /></View>}
  </View>;
}

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><SessionProvider><Routes /></SessionProvider></SafeAreaProvider></GestureHandlerRootView>;
}
