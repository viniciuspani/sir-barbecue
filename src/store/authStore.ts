import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';

import { supabase } from '@/data/remote/supabaseClient';

interface AuthState {
  session: Session | null;
  user: User | null;
  initializing: boolean;
  setSession: (session: Session | null) => void;
  signOut: () => Promise<void>;
  init: () => Promise<void>;
}

// Estado de autenticação (RF-01/02). A Fase 2 liga as telas de login/cadastro.
export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  initializing: true,
  setSession: (session) => set({ session, user: session?.user ?? null }),
  signOut: async () => {
    await supabase.auth.signOut();
    set({ session: null, user: null });
  },
  init: async () => {
    const { data } = await supabase.auth.getSession();
    set({ session: data.session, user: data.session?.user ?? null, initializing: false });
    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null });
    });
  },
}));
