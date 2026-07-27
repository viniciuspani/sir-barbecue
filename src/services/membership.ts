import { secureStorage } from '@/services/secureStorage';
import type { TenantRole } from '@/services/tenant';

// Cache local do vínculo (empresa + papel) por usuário, para o app funcionar
// OFFLINE: um usuário já verificado online consegue entrar sem rede; um usuário
// sem cache e sem rede não é liberado. Escopo por userId para não vazar entre
// contas no mesmo aparelho (espelha o padrão de services/onboarding.ts).
const key = (userId: string) => `membership.${userId}`;

export type CachedMembership = { tenantId: string; role: TenantRole };

export async function getCachedMembership(userId: string): Promise<CachedMembership | null> {
  const raw = await secureStorage.get(key(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedMembership;
    return parsed?.tenantId && parsed?.role ? parsed : null;
  } catch {
    return null;
  }
}

export async function setCachedMembership(userId: string, m: CachedMembership): Promise<void> {
  await secureStorage.set(key(userId), JSON.stringify(m));
}

export async function clearCachedMembership(userId: string): Promise<void> {
  await secureStorage.remove(key(userId));
}
