// Edge Function: send-push. SELF-CONTAINED (deployável pelo dashboard).
// Envia notificações via Expo Push API APENAS para os devices da própria empresa
// do usuário autenticado. NÃO aceita tokens arbitrários nem tenant_id de terceiros.
//
// Observação: o alerta automático de estoque baixo (RF-11) NÃO usa esta função —
// ele é disparado pelo trigger notify_low_stock via pg_net (ver
// docs/banco-multi-cliente/MIGRATION_02_push_tokens.sql). Esta função existe para
// envios manuais/administrativos dentro do escopo do próprio tenant.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// CORS restrito (o app mobile chama via functions.invoke, sem preflight de browser).
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

function userClient(req: Request): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );
}

type ExpoMessage = {
  to: string;
  sound: 'default';
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      tenant_id?: string;
      title?: string;
      body?: string;
      data?: Record<string, unknown>;
    };

    // 1) Exige usuário autenticado (a anon key sozinha NÃO basta).
    const u = userClient(req);
    const { data: auth } = await u.auth.getUser();
    if (!auth.user) return json({ error: 'Não autenticado.' }, 401);

    // 2) Resolve os tenants a que o usuário pertence; nunca aceita tokens/tenant de fora.
    const { data: allowed } = await u.rpc('user_tenant_ids');
    const memberTenants: string[] = Array.isArray(allowed)
      ? allowed.map((r) => (typeof r === 'string' ? r : (r as { user_tenant_ids?: string }).user_tenant_ids ?? '')).filter(Boolean)
      : [];
    if (memberTenants.length === 0) return json({ error: 'Sem empresa associada.' }, 403);

    // tenant_id opcional: se informado, precisa estar entre os do usuário; senão usa todos.
    const targetTenants = body.tenant_id
      ? memberTenants.filter((t) => t === body.tenant_id)
      : memberTenants;
    if (targetTenants.length === 0) return json({ error: 'Sem acesso à empresa informada.' }, 403);

    // 3) Busca os tokens SOMENTE dos tenants autorizados (service_role para ler todos os devices).
    const admin = adminClient();
    const { data: rows } = await admin
      .from('push_tokens')
      .select('token')
      .in('tenant_id', targetTenants);
    const tokens = ((rows ?? []) as { token: string }[])
      .map((r) => r.token)
      .filter((t) => typeof t === 'string' && t.length > 0);

    if (tokens.length === 0) return json({ error: 'Sem tokens para enviar.' }, 400);

    const messages: ExpoMessage[] = tokens.map((to) => ({
      to,
      sound: 'default',
      title: body.title,
      body: body.body,
      data: body.data,
    }));

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await res.json();
    return json({ ok: res.ok, result });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
