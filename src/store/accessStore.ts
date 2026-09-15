import { create } from 'zustand';

import { supabase } from '@/data/remote/supabaseClient';
import {
  type AccessReason,
  type DeletionInfo,
  evaluateAccess,
  isAccessEnforced,
} from '@/services/access';

type AccessStatus = 'checking' | 'allowed' | 'blocked' | 'disabled';

interface AccessState {
  status: AccessStatus;
  reason: AccessReason | null;
  daysRemaining: number;
  endsAt: string | null;
  /**
   * Somente-leitura: o cliente solicitou a exclusão da conta e a data ainda não
   * chegou. Ele CONSULTA tudo, mas não executa nenhuma ação. É um estado à parte
   * de `blocked` (assinatura) de propósito: bloquear a tela inteira tiraria dele o
   * botão de cancelar, que é o ponto da janela de arrependimento.
   */
  readOnly: boolean;
  deletion: DeletionInfo | null;
  /**
   * Verifica o acesso da empresa ativa. tenantId nulo = sem gate (fora do login).
   * silent=true (re-checagens em foreground/intervalo) não volta para 'checking',
   * evitando piscar a tela de carregamento por cima do app já aberto.
   */
  check: (tenantId: string | null, silent?: boolean) => Promise<void>;
  /** Cancela a solicitação de exclusão e revalida o acesso. Só owner. */
  cancelDeletion: (tenantId: string) => Promise<{ error: string | null }>;
}

// Controle de acesso (trial + assinatura + exclusão agendada) dirigido pelo servidor.
export const useAccessStore = create<AccessState>((set, get) => ({
  status: 'disabled',
  reason: null,
  daysRemaining: 0,
  endsAt: null,
  readOnly: false,
  deletion: null,
  check: async (tenantId, silent = false) => {
    // Sem empresa (não logado) ou bypass de dev → nada a bloquear.
    if (!tenantId || !isAccessEnforced()) {
      set({ status: 'disabled', reason: null, readOnly: false, deletion: null });
      return;
    }
    if (!silent) set({ status: 'checking' });
    const verdict = await evaluateAccess(tenantId);
    set({
      status: verdict.allowed ? 'allowed' : 'blocked',
      reason: verdict.reason,
      daysRemaining: verdict.daysRemaining,
      endsAt: verdict.endsAt,
      readOnly: verdict.readOnly,
      deletion: verdict.deletion,
    });
  },
  cancelDeletion: async (tenantId) => {
    const { error } = await supabase.rpc('cancel_account_deletion', { p_tenant_id: tenantId });
    if (error) return { error: 'Não foi possível cancelar a solicitação. Tente de novo.' };
    // Revalida sem piscar: o veredito novo é quem devolve a escrita ao app.
    await get().check(tenantId, true);
    return { error: null };
  },
}));
