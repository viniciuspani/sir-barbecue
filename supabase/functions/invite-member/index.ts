// Edge Function: invite-member. SELF-CONTAINED (deployável pelo dashboard).
// O owner adiciona um membro à empresa:
//  - usuário EXISTENTE → cria a membership direto;
//  - usuário NOVO → registra um convite PENDENTE em tenant_invites (sem pré-criar
//    usuário nem magic link). A pessoa se cadastra no app com esse e-mail e o trigger
//    handle_new_user_invite resolve o vínculo PELA TABELA (não por metadado).
// Pré-requisitos: MIGRATION_01_invite_trigger.sql + MIGRATION_02_invites_table.sql.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// CORS restrito: o app mobile chama via functions.invoke (sem preflight de browser),
// então o default nega origens de navegador. Defina ALLOWED_ORIGIN se um cliente web
// legítimo precisar chamar esta função.
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '';
const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
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

// Resolve o tenant do chamador. Se o corpo trouxer tenant_id, VALIDA que o usuário
// pertence a ele (via user_tenant_ids); senão cai para o claim/primeira membership.
async function resolveCaller(
  req: Request,
  requestedTenantId: string | null,
): Promise<{ userId: string; tenantId: string } | null> {
  const u = userClient(req);
  const { data } = await u.auth.getUser();
  const user = data.user;
  if (!user) return null;

  if (requestedTenantId) {
    const { data: allowed } = await u.rpc('user_tenant_ids');
    const ids = (allowed as { user_tenant_ids?: string }[] | string[] | null) ?? [];
    const list = Array.isArray(ids)
      ? ids.map((r) => (typeof r === 'string' ? r : (r as { user_tenant_ids?: string }).user_tenant_ids))
      : [];
    if (!list.includes(requestedTenantId)) return null; // não é membro do tenant pedido
    return { userId: user.id, tenantId: requestedTenantId };
  }

  const meta = user.app_metadata as { tenant_ids?: unknown } | undefined;
  const claim = Array.isArray(meta?.tenant_ids) && typeof meta?.tenant_ids[0] === 'string'
    ? (meta!.tenant_ids[0] as string)
    : null;
  if (claim) return { userId: user.id, tenantId: claim };
  const { data: row } = await u.from('tenant_members').select('tenant_id').limit(1).maybeSingle();
  const tid = (row as { tenant_id?: string } | null)?.tenant_id;
  return tid ? { userId: user.id, tenantId: tid } : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      role?: string;
      tenant_id?: string;
    };
    const email = body.email?.trim().toLowerCase();
    // 'owner' NUNCA é concedido por convite.
    const role = body.role === 'manager' ? 'manager' : 'employee';
    if (!email) return json({ error: 'Informe o e-mail.' }, 400);

    const caller = await resolveCaller(req, body.tenant_id ?? null);
    if (!caller) return json({ error: 'Não autenticado ou sem acesso à empresa.' }, 401);

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
      // Usuário novo: registra o convite (fonte da verdade) ANTES de disparar o e-mail.
      // O trigger handle_new_user_invite lê ESTA tabela pelo e-mail — não o metadado.
      // Idempotente sem depender de ON CONFLICT (o índice único é parcial/por
      // expressão em lower(email) where status='pending', que o PostgREST não casa):
      // remove convite pendente anterior e insere um novo com o papel atual.
      await admin
        .from('tenant_invites')
        .delete()
        .eq('tenant_id', caller.tenantId)
        .eq('email', email)
        .eq('status', 'pending');
      const { error: invErr } = await admin.from('tenant_invites').insert({
        tenant_id: caller.tenantId,
        email,
        role,
        invited_by: caller.userId,
        status: 'pending',
      });
      if (invErr) throw invErr;

      // Fluxo "cadastro pelo app": NÃO pré-criamos o usuário nem enviamos magic link
      // (deep link de e-mail é frágil em mobile). Basta a pessoa se cadastrar no app
      // com ESTE e-mail — o trigger handle_new_user_invite a vincula à empresa pelo
      // convite pendente acima.
      return json({ ok: true, invited: true, pending: true, email });
    }

    // Usuário existente → cria a membership direto (não passa pelo fluxo de convite).
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
