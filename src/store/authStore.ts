import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';

import { supabase } from '@/data/remote/supabaseClient';
import type { TenantRole } from '@/services/tenant';

interface AuthState {
  session: Session | null;
  user: User | null;
  initializing: boolean;
  /** Empresa (tenant) ativa do usuário — base do multi-tenant. */
  currentTenantId: string | null;
  /** Papel do usuário na empresa ativa — base do controle de acesso (RBAC). */
  currentRole: TenantRole | null;
  /** Bypass temporário de desenvolvimento (sem sessão real). */
  devAuthenticated: boolean;
  setSession: (session: Session | null) => void;
  signInDev: () => void;
  signOut: () => Promise<void>;
  init: () => Promise<void>;
}

// Resolve empresa ativa + papel consultando tenant_members — fonte CONFIÁVEL no cliente.
// NOTA: o claim do Custom Access Token Hook fica no JWT (auth.jwt() no servidor, p/ RLS),
// e NÃO em session.user.app_metadata — por isso não dá para ler o tenant de lá no cliente.
async function resolveTenant(): Promise<{ tenantId: string | null; role: TenantRole | null }> {
  try {
    // CRÍTICO: filtrar por user_id. A RLS members_select deixa o membro enxergar a
    // equipe INTEIRA da empresa; sem este filtro, .limit(1) retornava uma linha
    // arbitrária (tipicamente a do owner) e resolvia o papel do funcionário como
    // owner/manager, destravando telas de gestão (bug de RBAC).
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return { tenantId: null, role: null };

    const { data } = await supabase
      .from('tenant_members')
      .select('tenant_id, role')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    const row = data as { tenant_id?: string; role?: TenantRole } | null;
    return { tenantId: row?.tenant_id ?? null, role: row?.role ?? null };
  } catch {
    return { tenantId: null, role: null };
  }
}

// Estado de autenticação (RF-01/02) + empresa ativa (multi-tenant).
export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  initializing: true,
  currentTenantId: null,
  currentRole: null,
  devAuthenticated: false,
  setSession: (session) => set({ session, user: session?.user ?? null }),
  signInDev: () => set({ devAuthenticated: true }),
  signOut: async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore — Supabase pode não estar configurado ainda
    }
    set({ session: null, user: null, devAuthenticated: false, currentTenantId: null, currentRole: null });
  },
  init: async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      const { tenantId, role } = session
        ? await resolveTenant()
        : { tenantId: null, role: null };
      set({
        session,
        user: session?.user ?? null,
        currentTenantId: tenantId,
        currentRole: role,
        initializing: false,
      });

      // Resolve a empresa via query DEFERIDA (não chamar supabase dentro do onAuthStateChange).
      const refreshTenant = async (): Promise<void> => {
        const { tenantId: tid, role: r } = await resolveTenant();
        set({ currentTenantId: tid, currentRole: r });
      };

      supabase.auth.onAuthStateChange((event, s) => {
        set({ session: s, user: s?.user ?? null });
        if (!s || event === 'SIGNED_OUT') {
          set({ currentTenantId: null, currentRole: null });
          return;
        }
        setTimeout(() => void refreshTenant(), 0);
      });
    } catch (e) {
      console.warn('[auth] init falhou (Supabase não configurado?)', e);
      set({ session: null, user: null, currentTenantId: null, currentRole: null, initializing: false });
    }
  },
}));
