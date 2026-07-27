import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';

import { db } from '@/data/local/database';
import { tabItems, tabs } from '@/data/local/schema';
import { supabase } from '@/data/remote/supabaseClient';
import {
  clearCachedMembership,
  getCachedMembership,
  setCachedMembership,
} from '@/services/membership';
import type { TenantRole } from '@/services/tenant';
import { useCartStore } from '@/store/cartStore';

// Estado da resolução do vínculo com a empresa:
//  - 'resolving': ainda descobrindo (1ª resolução em voo) → mostrar splash.
//  - 'member': usuário vinculado a uma empresa → app liberado.
//  - 'none': autenticado, mas SEM vínculo (não convidado) → bloquear.
export type MembershipStatus = 'resolving' | 'member' | 'none';

interface AuthState {
  session: Session | null;
  user: User | null;
  initializing: boolean;
  /** Empresa (tenant) ativa do usuário — base do multi-tenant. */
  currentTenantId: string | null;
  /** Papel do usuário na empresa ativa — base do controle de acesso (RBAC). */
  currentRole: TenantRole | null;
  /** Situação do vínculo com a empresa (gate de acesso ao app). */
  membershipStatus: MembershipStatus;
  /** Bypass temporário de desenvolvimento (sem sessão real). */
  devAuthenticated: boolean;
  setSession: (session: Session | null) => void;
  signInDev: () => void;
  signOut: () => Promise<void>;
  init: () => Promise<void>;
}

type ResolvedMembership = { tenantId: string | null; role: TenantRole | null; status: MembershipStatus };

// Resolve empresa ativa + papel consultando tenant_members — fonte CONFIÁVEL no cliente.
// NOTA: o claim do Custom Access Token Hook fica no JWT (auth.jwt() no servidor, p/ RLS),
// e NÃO em session.user.app_metadata — por isso não dá para ler o tenant de lá no cliente.
// Recebe o userId da SESSÃO (não usa getUser() — ida à rede frágil que fazia o papel
// resolver como "—"). Distingue "sem vínculo" (query OK, sem linha) de "offline"
// (query falhou → cai no cache por usuário, para o app funcionar sem rede).
async function resolveMembership(userId: string): Promise<ResolvedMembership> {
  try {
    // CRÍTICO: filtrar por user_id. A RLS members_select deixa o membro enxergar a
    // equipe INTEIRA da empresa; sem este filtro, .limit(1) retornava uma linha
    // arbitrária (tipicamente a do owner) e resolvia o papel errado.
    const { data, error } = await supabase
      .from('tenant_members')
      .select('tenant_id, role')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (error) throw error; // erro real (rede/permissão) → trata como offline (cache)
    const row = data as { tenant_id?: string; role?: TenantRole } | null;
    if (row?.tenant_id && row.role) {
      await setCachedMembership(userId, { tenantId: row.tenant_id, role: row.role });
      return { tenantId: row.tenant_id, role: row.role, status: 'member' };
    }
    // Query OK e SEM linha → usuário autenticado mas sem vínculo com empresa.
    await clearCachedMembership(userId);
    return { tenantId: null, role: null, status: 'none' };
  } catch {
    // Falha de rede/erro → fallback no cache (usuário já verificado antes, offline).
    const cached = await getCachedMembership(userId);
    if (cached) return { tenantId: cached.tenantId, role: cached.role, status: 'member' };
    return { tenantId: null, role: null, status: 'none' };
  }
}

// Limpa o working state LOCAL (carrinho + comandas) ao trocar de sessão, para não
// vazar dados de uma conta para outra no mesmo aparelho.
async function resetWorkingState(): Promise<void> {
  useCartStore.getState().clear();
  try {
    await db.delete(tabItems);
    await db.delete(tabs);
  } catch {
    // ignore — banco pode não estar pronto
  }
}

// Estado de autenticação (RF-01/02) + empresa ativa (multi-tenant).
export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  initializing: true,
  currentTenantId: null,
  currentRole: null,
  membershipStatus: 'resolving',
  devAuthenticated: false,
  setSession: (session) => set({ session, user: session?.user ?? null }),
  signInDev: () => set({ devAuthenticated: true }),
  signOut: async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore — Supabase pode não estar configurado ainda
    }
    await resetWorkingState();
    set({
      session: null,
      user: null,
      devAuthenticated: false,
      currentTenantId: null,
      currentRole: null,
      membershipStatus: 'none',
    });
  },
  init: async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      const membership = session?.user
        ? await resolveMembership(session.user.id)
        : { tenantId: null, role: null, status: 'none' as MembershipStatus };
      set({
        session,
        user: session?.user ?? null,
        currentTenantId: membership.tenantId,
        currentRole: membership.role,
        membershipStatus: membership.status,
        initializing: false,
      });

      // Resolve o vínculo via query DEFERIDA (não chamar supabase dentro do onAuthStateChange).
      const refreshMembership = async (userId: string): Promise<void> => {
        set({ membershipStatus: 'resolving' });
        const m = await resolveMembership(userId);
        set({ currentTenantId: m.tenantId, currentRole: m.role, membershipStatus: m.status });
      };

      supabase.auth.onAuthStateChange((event, s) => {
        set({ session: s, user: s?.user ?? null });
        if (!s || event === 'SIGNED_OUT') {
          set({ currentTenantId: null, currentRole: null, membershipStatus: 'none' });
          return;
        }
        set({ membershipStatus: 'resolving' });
        setTimeout(() => void refreshMembership(s.user.id), 0);
      });
    } catch (e) {
      console.warn('[auth] init falhou (Supabase não configurado?)', e);
      set({
        session: null,
        user: null,
        currentTenantId: null,
        currentRole: null,
        membershipStatus: 'none',
        initializing: false,
      });
    }
  },
}));
