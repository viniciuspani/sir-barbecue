// Controle de acesso por papel (RBAC). Leitura é liberada a todos os membros em
// todo o app (o caixa precisa ler produtos/estoque para vender); o que varia por
// papel é a ESCRITA e o acesso a telas sensíveis (financeiro/empresa/relatórios).
// Espelho da RLS do servidor — a UI esconde, a RLS é a barreira real.
import { useAccessStore } from '@/store/accessStore';
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
// Exportar dados: só owner (o zip carrega custo de fornecedor e cobrança da assinatura).
export const canAccessExport = isOwner;

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
  canAccessExport: boolean;
  canWriteSuppliers: boolean;
  canWriteCatalog: boolean;
  /**
   * Empresa em somente-leitura: há exclusão de conta agendada (MIGRATION_24).
   * Consulta e exportação continuam; toda AÇÃO fica bloqueada.
   */
  readOnly: boolean;
  /** Motivo a mostrar quando o usuário toca numa ação bloqueada. */
  readOnlyReason: string | null;
}

/**
 * Hook: permissões derivadas do papel do usuário na empresa ativa, já descontado
 * o somente-leitura da exclusão agendada.
 *
 * ⚠️ O somente-leitura é aplicado AQUI, no hook, e NÃO nos predicados puros acima.
 * `syncEngine.ts` chama `canWriteCatalog(role)`/`canWriteSuppliers(role)` direto
 * para decidir o que empurrar: aplicá-lo lá mataria o dreno do sync, que é
 * justamente o que impede a venda registrada offline de se perder na exclusão.
 */
export function usePermissions(): Permissions {
  const role = useAuthStore((s) => s.currentRole);
  const readOnly = useAccessStore((s) => s.readOnly);
  const canCancel = useAccessStore((s) => s.deletion?.canCancel ?? false);

  // Duas mensagens: quem pode cancelar recebe a saída junto com o motivo; quem
  // não pode (gerente/funcionário) é mandado falar com o dono, em vez de procurar
  // um botão que não existe para ele.
  let readOnlyReason: string | null = null;
  if (readOnly) {
    readOnlyReason = canCancel
      ? 'Só consulta: você pediu a exclusão da conta. Para voltar a vender, cancele em Início.'
      : 'Só consulta: o dono pediu a exclusão da conta. Fale com ele para liberar o app.';
  }

  return {
    role,
    canAccessHome: canAccessHome(role),
    canAccessProducts: canAccessProducts(role),
    canAccessStock: canAccessStock(role),
    canAccessCompany: canAccessCompany(role),
    canAccessReports: canAccessReports(role),
    canAccessSuppliers: canAccessSuppliers(role),
    // Exportar dados continua liberado de propósito: é LEITURA, e são os dados
    // dele. Travar a exportação de quem está saindo seria reter dado alheio.
    canAccessExport: canAccessExport(role),
    // ⚠️ Os `canWrite*` continuam dependendo SÓ DO PAPEL, de propósito: várias
    // telas os usam como guarda de navegação (`if (!canWriteCatalog) return
    // <Redirect/>`). Zerá-los no somente-leitura expulsaria o usuário da tela de
    // produto sem explicar nada — e o contrato do estado é "vê tudo, não age".
    // Quem bloqueia a AÇÃO é `readOnlyReason` — via `disabledReason` no Button,
    // ou checado na entrada do handler. A barreira real é a RLS do servidor.
    canWriteSuppliers: canWriteSuppliers(role),
    canWriteCatalog: canWriteCatalog(role),
    readOnly,
    readOnlyReason,
  };
}
