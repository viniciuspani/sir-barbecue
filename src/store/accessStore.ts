import { create } from 'zustand';

import { type AccessReason, evaluateAccess, isAccessEnforced } from '@/services/access';

type AccessStatus = 'checking' | 'allowed' | 'blocked' | 'disabled';

interface AccessState {
  status: AccessStatus;
  reason: AccessReason | null;
  daysRemaining: number;
  endsAt: string | null;
  /**
   * Verifica o acesso da empresa ativa. tenantId nulo = sem gate (fora do login).
   * silent=true (re-checagens em foreground/intervalo) não volta para 'checking',
   * evitando piscar a tela de carregamento por cima do app já aberto.
   */
  check: (tenantId: string | null, silent?: boolean) => Promise<void>;
}

// Controle de acesso (trial + assinatura) dirigido pelo servidor.
export const useAccessStore = create<AccessState>((set) => ({
  status: 'disabled',
  reason: null,
  daysRemaining: 0,
  endsAt: null,
  check: async (tenantId, silent = false) => {
    // Sem empresa (não logado) ou bypass de dev → nada a bloquear.
    if (!tenantId || !isAccessEnforced()) {
      set({ status: 'disabled', reason: null });
      return;
    }
    if (!silent) set({ status: 'checking' });
    const verdict = await evaluateAccess(tenantId);
    set({
      status: verdict.allowed ? 'allowed' : 'blocked',
      reason: verdict.reason,
      daysRemaining: verdict.daysRemaining,
      endsAt: verdict.endsAt,
    });
  },
}));
