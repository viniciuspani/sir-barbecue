import NetInfo from '@react-native-community/netinfo';

import { useConnectivityStore } from '@/store/connectivityStore';

// Inicia o monitor de conectividade (RF-15/16) e alimenta o connectivityStore.
// Retorna a função de unsubscribe.
export function startConnectivityMonitor(): () => void {
  return NetInfo.addEventListener((state) => {
    const online = Boolean(state.isConnected && state.isInternetReachable !== false);
    useConnectivityStore.getState().setOnline(online);
  });
}
