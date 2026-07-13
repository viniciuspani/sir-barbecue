import { supabase } from '@/data/remote/supabaseClient';

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
export type TenantMember = { userId: string; role: TenantRole };

function msg(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return 'Erro inesperado. Verifique a conexão.';
}

export async function fetchTenant(tenantId: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, cnpj, phone, logo_url')
    .eq('id', tenantId)
    .maybeSingle();
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
  return { error: error ? msg(error) : null };
}

export async function fetchMembers(tenantId: string): Promise<TenantMember[]> {
  const { data, error } = await supabase
    .from('tenant_members')
    .select('user_id, role')
    .eq('tenant_id', tenantId);
  if (error || !data) return [];
  return (data as { user_id: string; role: string }[]).map((r) => ({
    userId: r.user_id,
    role: r.role as TenantRole,
  }));
}

export async function removeMember(
  tenantId: string,
  userId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('tenant_members')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
  return { error: error ? msg(error) : null };
}
