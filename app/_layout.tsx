import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { refreshPendingCount, runSync } from '@/data/sync/syncEngine';
import { colors } from '@/design/tokens';
import { startConnectivityMonitor } from '@/services/netinfo';
import { registerAndSavePushToken } from '@/services/push';
import { useAuthStore } from '@/store/authStore';
import { useConnectivityStore } from '@/store/connectivityStore';

/**
 * Provider raiz da Presentation (Expo Router v7).
 * Inicializa auth + monitor de conectividade; dispara o sync ao (re)conectar (RF-16).
 */
export default function RootLayout() {
  const init = useAuthStore((s) => s.init);
  const isOnline = useConnectivityStore((s) => s.isOnline);
  const currentTenantId = useAuthStore((s) => s.currentTenantId);

  useEffect(() => {
    init();
    const stop = startConnectivityMonitor();
    refreshPendingCount();
    return stop;
  }, [init]);

  // Sincroniza ao (re)conectar OU quando a empresa ativa é resolvida (após login).
  useEffect(() => {
    if (isOnline && currentTenantId) runSync();
  }, [isOnline, currentTenantId]);

  // Mantém o token de push salvo quando há empresa ativa (só se a permissão já foi concedida).
  useEffect(() => {
    if (currentTenantId) void registerAndSavePushToken({ prompt: false });
  }, [currentTenantId]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
