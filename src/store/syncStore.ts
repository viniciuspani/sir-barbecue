import { create } from 'zustand';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

interface SyncState {
  status: SyncStatus;
  lastSyncedAt?: number;
  pending: number;
  setStatus: (status: SyncStatus) => void;
  setPending: (pending: number) => void;
  markSynced: () => void;
}

// Estado da sincronização (indicadores visuais offline/online — doc 01c §10.4).
export const useSyncStore = create<SyncState>((set) => ({
  status: 'idle',
  pending: 0,
  setStatus: (status) => set({ status }),
  setPending: (pending) => set({ pending }),
  markSynced: () => set({ status: 'synced', lastSyncedAt: Date.now(), pending: 0 }),
}));
