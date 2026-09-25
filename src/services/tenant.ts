import { supabase } from '@/data/remote/supabaseClient';
import { logSilently } from '@/lib/feedback';

// Serviço de empresa (multi-tenant). Dados ficam no servidor (tenants/tenant_members) —
// estas operações são ONLINE; a RLS garante o isolamento e o owner-only nas escritas.

// Nome padrão criado no bootstrap (handle_new_user). Usado para detectar que o
// usuário ainda não personalizou o negócio (nudge de onboarding na Home).
export const DEFAULT_TENANT_NAME = 'Minha Empresa';

export type Tenant = {
  id: string;
  name: string;
  cnpj?: string;
  phone?: string;
  logoUrl?: string;
};

export type TenantRole = 'owner' | 'manager' | 'employee';
/** `active: false` = vínculo INATIVADO (tenant_members.removed_at preenchido). */
export type TenantMember = { userId: string; role: TenantRole; active: boolean; name: string };

function msg(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return 'Erro inesperado. Verifique a conexão.';
}

// Estas consultas degradam para null/[] quando falham — o que torna um erro de
// permissão indistinguível de "não há dados". O log preserva a causa real.
function record(error: unknown, action: string): void {
  if (error) logSilently(error, { action, screen: 'empresa' });
}

/** Por que o usuário está sem empresa — ver `my_membership_status` (MIGRATION_26). */
export type MembershipReason = 'never' | 'removed' | 'tenant_deleted';

export type MembershipDetail = {
  status: 'member' | 'none';
  reason: MembershipReason | null;
  /** Quando perdeu o vínculo (inativação ou exclusão da empresa). */
  occurredAt: string | null;
  /** Data em que a conta órfã será encerrada, quando aplicável. */
  purgeAfter: string | null;
  email: string | null;
};

/**
 * Descobre POR QUE o usuário está sem empresa. Sem isto o app não distingue
 * "nunca foi adicionado" de "a empresa encerrou" — os dois chegam como zero
 * linhas em `tenant_members` (no segundo caso o cascade apaga a linha inteira).
 */
export async function fetchMembershipDetail(): Promise<MembershipDetail | null> {
  const { data, error } = await supabase.rpc('my_membership_status');
  if (error) {
    logSilently(error, { action: 'Descobrir a situação do vínculo', screen: 'membership' });
    return null;
  }
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    status: d.status === 'member' ? 'member' : 'none',
    reason: (d.reason as MembershipReason | null) ?? null,
    occurredAt: (d.occurredAt as string | null) ?? null,
    purgeAfter: (d.purgeAfter as string | null) ?? null,
    email: (d.email as string | null) ?? null,
  };
}

export async function fetchTenant(tenantId: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, cnpj, phone, logo_url')
    .eq('id', tenantId)
    .maybeSingle();
  record(error, 'Buscar os dados da empresa');
  if (error || !data) return null;
  const row = data as {
    id: string;
    name: string;
    cnpj: string | null;
    phone: string | null;
    logo_url: string | null;
  };
  return {
    id: row.id,
    name: row.name,
    cnpj: row.cnpj ?? undefined,
    phone: row.phone ?? undefined,
    logoUrl: row.logo_url ?? undefined,
  };
}

export async function updateTenant(
  tenantId: string,
  patch: { name: string; cnpj?: string; phone?: string },
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('tenants')
    .update({ name: patch.name, cnpj: patch.cnpj || null, phone: patch.phone || null })
    .eq('id', tenantId);
  record(error, 'Salvar os dados da empresa');
  return { error: error ? msg(error) : null };
}

export async function fetchMembers(tenantId: string): Promise<TenantMember[]> {
  // RPC (não select direto): nome/e-mail moram em auth.users, que um usuário
  // comum não lê para outra pessoa — list_tenant_members (MIGRATION_31) faz
  // esse join com SECURITY DEFINER, restrito a owner/manager da empresa.
  const { data, error } = await supabase.rpc('list_tenant_members', { p_tenant_id: tenantId });
  record(error, 'Buscar a equipe da empresa');
  if (error || !data) return [];
  return (
    data as {
      user_id: string;
      role: string;
      removed_at: string | null;
      email: string | null;
      display_name: string | null;
    }[]
  ).map((r) => ({
    userId: r.user_id,
    role: r.role as TenantRole,
    active: r.removed_at === null,
    name: r.display_name?.trim() || r.email || r.user_id.slice(0, 8),
  }));
}

/**
 * INATIVA o vínculo — não apaga o usuário.
 *
 * O dono da empresa é titular do VÍNCULO, não dos dados pessoais da pessoa:
 * ele pode revogar a capacidade dela de atuar aqui, não excluir a conta dela.
 * Só o próprio usuário exclui a própria conta (delete-account / RNF-08).
 *
 * Tecnicamente também não daria mais para apagar: desde a MIGRATION_21 as vendas,
 * entradas de estoque e relatórios apontam para esta linha por FK composta
 * (`*_actor_fkey`) — ela é o ATOR do histórico da empresa. Um DELETE seria
 * barrado pelo banco assim que a pessoa tivesse registrado qualquer coisa.
 *
 * `removed_at` preenchido faz `user_tenant_ids()` parar de devolver esta empresa:
 * o acesso cai na hora, e o histórico fica.
 */
export async function deactivateMember(
  tenantId: string,
  userId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('tenant_members')
    .update({ removed_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
  record(error, 'Inativar membro da equipe');
  return { error: error ? msg(error) : null };
}

/**
 * Reativa o vínculo. Desfaz um clique errado — e é o caminho para o funcionário
 * inativado conseguir enviar vendas que ficaram retidas no aparelho dele: o dono
 * reativa, o app sincroniza, o dono inativa de novo. A escrita entra na empresa
 * com autorização explícita de quem responde por ela.
 */
export async function reactivateMember(
  tenantId: string,
  userId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('tenant_members')
    .update({ removed_at: null })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
  record(error, 'Reativar membro da equipe');
  return { error: error ? msg(error) : null };
}
