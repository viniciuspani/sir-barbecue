import { create } from 'zustand';

interface ConnectivityState {
  isOnline: boolean;
  setOnline: (isOnline: boolean) => void;
}

// Estado de conectividade (RF-15/16) — alimentado pelo services/netinfo.
export const useConnectivityStore = create<ConnectivityState>((set) => ({
  isOnline: true,
  setOnline: (isOnline) => set({ isOnline }),
}));
