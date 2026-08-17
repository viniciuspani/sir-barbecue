import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { refreshPendingCount, runSync } from '@/data/sync/syncEngine';
import { colors } from '@/design/tokens';
import { bindDevice } from '@/services/access';
import { trackScreen } from '@/services/breadcrumbs';
import { installGlobalErrorHandlers } from '@/services/errorHandlers';
import { startConnectivityMonitor } from '@/services/netinfo';
import { registerAndSavePushToken } from '@/services/push';
import { useAccessStore } from '@/store/accessStore';
import { useAuthStore } from '@/store/authStore';
import { useConnectivityStore } from '@/store/connectivityStore';
import { AccessBlocked } from '@/ui/AccessBlocked';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { Splash } from '@/ui/Splash';

// Export reconhecido pelo Expo Router: substitui a tela branca por uma tela
// amigável quando um erro quebra o render, e registra a falha no log.
export { ErrorScreen as ErrorBoundary };

// Handlers globais (crash de JS + promise rejeitada) instalados no boot, ANTES
// de qualquer render — erro no próprio boot também precisa ser registrado.
installGlobalErrorHandlers();

const RECHECK_INTERVAL_MS = 30 * 60 * 1000; // re-checa o acesso a cada 30 min
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // fallback: sincroniza a cada 5 min se nenhum gatilho disparar

/**
 * Provider raiz da Presentation (Expo Router v7).
 * Inicializa auth + monitor de conectividade; dispara o sync ao (re)conectar (RF-16)
 * e aplica o gate de acesso (trial/assinatura) quando há empresa ativa.
 */
export default function RootLayout() {
  const init = useAuthStore((s) => s.init);
  const pathname = usePathname();
  const isOnline = useConnectivityStore((s) => s.isOnline);
  const currentTenantId = useAuthStore((s) => s.currentTenantId);
  const accessStatus = useAccessStore((s) => s.status);
  const accessReason = useAccessStore((s) => s.reason);
  const checkAccess = useAccessStore((s) => s.check);

  useEffect(() => {
    init();
    const stop = startConnectivityMonitor();
    refreshPendingCount();
    return stop;
  }, [init]);

  // Trilha de navegação: alimenta o log com o caminho que o usuário percorreu
  // até o erro ("o que ele estava fazendo"), não só a tela final.
  useEffect(() => {
    trackScreen(pathname);
  }, [pathname]);

  // Sincroniza ao (re)conectar OU quando a empresa ativa é resolvida (após login).
  useEffect(() => {
    if (isOnline && currentTenantId) runSync();
  }, [isOnline, currentTenantId]);

  // Fallback: sincroniza a cada 5 min caso nenhum gatilho (reconexão, pull-to-refresh,
  // fechamento de venda, mutação de fornecedor) tenha disparado nesse intervalo.
  useEffect(() => {
    if (!currentTenantId) return;
    const interval = setInterval(() => {
      if (useConnectivityStore.getState().isOnline) void runSync();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [currentTenantId]);

  // Mantém o token de push salvo quando há empresa ativa (só se a permissão já foi concedida).
  useEffect(() => {
    if (currentTenantId) void registerAndSavePushToken({ prompt: false });
  }, [currentTenantId]);

  // Vincula o aparelho à empresa e verifica o acesso quando o tenant resolve.
  useEffect(() => {
    if (currentTenantId) {
      void bindDevice(currentTenantId);
      void checkAccess(currentTenantId, false);
    } else {
      void checkAccess(null);
    }
  }, [currentTenantId, checkAccess]);

  // Re-checa o acesso ao voltar para foreground e periodicamente (silencioso).
  useEffect(() => {
    if (!currentTenantId) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkAccess(currentTenantId, true);
    });
    const interval = setInterval(() => void checkAccess(currentTenantId, true), RECHECK_INTERVAL_MS);
    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, [currentTenantId, checkAccess]);

  const renderContent = () => {
    if (accessStatus === 'blocked') return <AccessBlocked reason={accessReason} />;
    if (accessStatus === 'checking') return <Splash />;
    return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {renderContent()}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
