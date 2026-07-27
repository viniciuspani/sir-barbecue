// Controle de acesso por papel (RBAC). Leitura é liberada a todos os membros em
// todo o app (o caixa precisa ler produtos/estoque para vender); o que varia por
// papel é a ESCRITA e o acesso a telas sensíveis (financeiro/empresa/relatórios).
// Espelho da RLS do servidor — a UI esconde, a RLS é a barreira real.
import { useAuthStore } from '@/store/authStore';
import type { TenantRole } from '@/services/tenant';

const isOwner = (role: TenantRole | null): boolean => role === 'owner';
const isManagerUp = (role: TenantRole | null): boolean => role === 'owner' || role === 'manager';

// Acesso a telas (owner e manager; employee fica de fora).
export const canAccessHome = isManagerUp;
export const canAccessProducts = isManagerUp;
export const canAccessStock = isManagerUp;
export const canAccessCompany = isManagerUp;
export const canAccessReports = isManagerUp;
// Fornecedores: só owner/manager veem a tela (employee fica de fora).
export const canAccessSuppliers = isManagerUp;

// Escrita de fornecedores e vínculos produto↔fornecedor: só owner.
export const canWriteSuppliers = isOwner;
// Escrita de catálogo/estoque (produtos, estoque): owner e manager.
export const canWriteCatalog = isManagerUp;

// Rótulo do papel em pt-BR para exibição na UI (ex.: cabeçalho da Venda).
const ROLE_LABELS: Record<TenantRole, string> = {
  owner: 'Dono',
  manager: 'Gerente',
  employee: 'Funcionário',
};
export function roleLabel(role: TenantRole | null): string {
  return role ? ROLE_LABELS[role] : '—';
}

export interface Permissions {
  role: TenantRole | null;
  canAccessHome: boolean;
  canAccessProducts: boolean;
  canAccessStock: boolean;
  canAccessCompany: boolean;
  canAccessReports: boolean;
  canAccessSuppliers: boolean;
  canWriteSuppliers: boolean;
  canWriteCatalog: boolean;
}

/** Hook: permissões derivadas do papel do usuário na empresa ativa. */
export function usePermissions(): Permissions {
  const role = useAuthStore((s) => s.currentRole);
  return {
    role,
    canAccessHome: canAccessHome(role),
    canAccessProducts: canAccessProducts(role),
    canAccessStock: canAccessStock(role),
    canAccessCompany: canAccessCompany(role),
    canAccessReports: canAccessReports(role),
    canAccessSuppliers: canAccessSuppliers(role),
    canWriteSuppliers: canWriteSuppliers(role),
    canWriteCatalog: canWriteCatalog(role),
  };
}
