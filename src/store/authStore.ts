import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';

import { supabase } from '@/data/remote/supabaseClient';

interface AuthState {
  session: Session | null;
  user: User | null;
  initializing: boolean;
  /** Empresa (tenant) ativa do usuário — base do multi-tenant. */
  currentTenantId: string | null;
  /** Bypass temporário de desenvolvimento (sem sessão real). */
  devAuthenticated: boolean;
  setSession: (session: Session | null) => void;
  signInDev: () => void;
  signOut: () => Promise<void>;
  init: () => Promise<void>;
}

// Resolve a empresa ativa consultando tenant_members — fonte CONFIÁVEL no cliente.
// NOTA: o claim do Custom Access Token Hook fica no JWT (auth.jwt() no servidor, p/ RLS),
// e NÃO em session.user.app_metadata — por isso não dá para ler o tenant de lá no cliente.
async function resolveTenantId(): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('tenant_members')
      .select('tenant_id')
      .limit(1)
      .maybeSingle();
    return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
  } catch {
    return null;
  }
}

// Estado de autenticação (RF-01/02) + empresa ativa (multi-tenant).
export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  initializing: true,
  currentTenantId: null,
  devAuthenticated: false,
  setSession: (session) => set({ session, user: session?.user ?? null }),
  signInDev: () => set({ devAuthenticated: true }),
  signOut: async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore — Supabase pode não estar configurado ainda
    }
    set({ session: null, user: null, devAuthenticated: false, currentTenantId: null });
  },
  init: async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      const currentTenantId = session ? await resolveTenantId() : null;
      set({ session, user: session?.user ?? null, currentTenantId, initializing: false });

      // Resolve a empresa via query DEFERIDA (não chamar supabase dentro do onAuthStateChange).
      const refreshTenant = async (): Promise<void> => {
        set({ currentTenantId: await resolveTenantId() });
      };

      supabase.auth.onAuthStateChange((event, s) => {
        set({ session: s, user: s?.user ?? null });
        if (!s || event === 'SIGNED_OUT') {
          set({ currentTenantId: null });
          return;
        }
        setTimeout(() => void refreshTenant(), 0);
      });
    } catch (e) {
      console.warn('[auth] init falhou (Supabase não configurado?)', e);
      set({ session: null, user: null, currentTenantId: null, initializing: false });
    }
  },
}));
