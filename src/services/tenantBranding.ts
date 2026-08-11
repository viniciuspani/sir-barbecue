import { DEFAULT_TENANT_NAME } from '@/services/tenant';
import { secureStorage } from '@/services/secureStorage';

// Último nome de empresa conhecido NESTE APARELHO — usado para personalizar a tela
// de login, que roda ANTES da sessão existir (não há tenantId para consultar o
// servidor ali). Chave de dispositivo (não por usuário): o objetivo é a marca do
// negócio que usa este aparelho continuar aparecendo mesmo deslogado.
const KEY = 'tenant.lastKnownName';

export async function getCachedTenantName(): Promise<string | null> {
  try {
    const name = await secureStorage.get(KEY);
    // O nome padrão do bootstrap não conta como "empresa nomeada" — trata como vazio.
    return name && name !== DEFAULT_TENANT_NAME ? name : null;
  } catch {
    return null;
  }
}

export async function setCachedTenantName(name: string): Promise<void> {
  if (!name || name === DEFAULT_TENANT_NAME) return;
  try {
    await secureStorage.set(KEY, name);
  } catch {
    // ignore — a tela de login cai no placeholder
  }
}
