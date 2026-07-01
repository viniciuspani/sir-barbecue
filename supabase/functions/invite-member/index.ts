// Edge Function: invite-member. SELF-CONTAINED (deployável pelo dashboard).
// O owner adiciona um membro à empresa:
//  - usuário EXISTENTE → cria a membership direto;
//  - usuário NOVO → inviteUserByEmail com metadado invited_to_tenant; o trigger
//    handle_new_user_invite vincula o novo usuário à empresa que convidou (sem empresa própria).
// Pré-requisito: aplicar docs/banco-multi-cliente/MIGRATION_01_invite_trigger.sql.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );
}

function userClient(req: Request): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
}

async function getCallerTenant(req: Request): Promise<{ userId: string; tenantId: string } | null> {
  const u = userClient(req);
  const { data } = await u.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const meta = user.app_metadata as { tenant_ids?: unknown } | undefined;
  const ids = meta?.tenant_ids;
  const claim = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : null;
  if (claim) return { userId: user.id, tenantId: claim };
  const { data: row } = await u.from('tenant_members').select('tenant_id').limit(1).maybeSingle();
  const tid = (row as { tenant_id?: string } | null)?.tenant_id;
  return tid ? { userId: user.id, tenantId: tid } : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const caller = await getCallerTenant(req);
    if (!caller) return json({ error: 'Não autenticado.' }, 401);

    const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string };
    const email = body.email?.trim().toLowerCase();
    const role = body.role === 'manager' || body.role === 'employee' ? body.role : 'employee';
    if (!email) return json({ error: 'Informe o e-mail.' }, 400);

    // Só o owner da empresa pode convidar.
    const u = userClient(req);
    const { data: me } = await u
      .from('tenant_members')
      .select('role')
      .eq('tenant_id', caller.tenantId)
      .eq('user_id', caller.userId)
      .maybeSingle();
    if ((me as { role?: string } | null)?.role !== 'owner') {
      return json({ error: 'Apenas o dono (owner) pode convidar membros.' }, 403);
    }

    const admin = adminClient();
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) throw listErr;
    const existing = list.users.find((x) => x.email?.toLowerCase() === email);

    if (!existing) {
      // Usuário novo → convite por e-mail com o flag p/ o trigger handle_new_user_invite
      // vinculá-lo à empresa que convidou (em vez de criar empresa própria).
      const { error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { invited_to_tenant: caller.tenantId, invited_role: role },
      });
      if (invErr) throw invErr;
      return json({ ok: true, invited: true, email });
    }

    // Usuário existente → cria a membership direto.
    const { error } = await admin
      .from('tenant_members')
      .upsert(
        { tenant_id: caller.tenantId, user_id: existing.id, role },
        { onConflict: 'tenant_id,user_id', ignoreDuplicates: true },
      );
    if (error) throw error;

    return json({ ok: true, userId: existing.id, role });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
