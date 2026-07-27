import { useAuthStore } from '@/store/authStore';

/**
 * Empresa (tenant) ativa para CARIMBAR gravações locais. Lança se não houver
 * empresa ativa — trava de segurança: um usuário sem vínculo não grava nada no
 * banco local (a UI já bloqueia; isto cobre deep-link/race). Lê de forma preguiçosa
 * (getState) para não criar ciclo de import com o authStore.
 */
export function getActiveTenantIdOrThrow(): string {
  const tenantId = useAuthStore.getState().currentTenantId;
  if (!tenantId) {
    throw new Error('Operação bloqueada: usuário sem empresa ativa (sem vínculo).');
  }
  return tenantId;
}

/**
 * Empresa ativa para ESCOPAR leituras locais (não lança). Retorna null quando não há
 * empresa — os repos devolvem vazio, para nunca exibir dado de outra empresa que ainda
 * esteja no cache do SQLite compartilhado do aparelho.
 */
export function getActiveTenantId(): string | null {
  return useAuthStore.getState().currentTenantId;
}
