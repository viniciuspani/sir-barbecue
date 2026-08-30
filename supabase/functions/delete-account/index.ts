// Edge Function: delete-account (RNF-08). SELF-CONTAINED (deployável pelo dashboard).
// Exclui a conta do usuário autenticado:
//  - apaga as empresas em que ele é o dono (cascade remove todos os dados + memberships);
//  - remove memberships restantes (onde é apenas membro);
//  - exclui o usuário do Auth.
// AÇÃO DESTRUTIVA E IRREVERSÍVEL.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// CORS restrito. Desde o app WEB (PWA), estas funções passaram a ser chamadas de
// dentro do NAVEGADOR — e o app roda em mais de uma origem ao mesmo tempo:
// produção, o localhost do desenvolvimento e o IP da máquina no teste em celular.
// Por isso ALLOWED_ORIGIN aceita uma LISTA separada por vírgula, e ecoamos de volta
// apenas a origem que bateu (nunca "*"):
//   supabase secrets set ALLOWED_ORIGIN="https://app.exemplo,http://localhost:5173"
// O app mobile chama via functions.invoke, sem preflight de browser: segue
// funcionando mesmo com a variável vazia.
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGIN') ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, '')) // tolera barra final ao colar a URL
  .filter(Boolean);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = (req.headers.get('Origin') ?? '').replace(/\/+$/, '');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    // Sem isto, um cache intermediário pode servir a resposta de uma origem para outra.
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// Devolve o `json` já preso à origem DESTA requisição. O handler o usa como antes.
function jsonFor(req: Request) {
  const cors = corsHeadersFor(req);
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
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

type IdRow = { id: string };

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const json = jsonFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const u = userClient(req);
    const { data } = await u.auth.getUser();
    const user = data.user;
    if (!user) return json({ error: 'Não autenticado.' }, 401);

    const admin = adminClient();

    const { data: ownedData, error: ownedErr } = await admin
      .from('tenants')
      .select('id')
      .eq('owner_user_id', user.id);
    if (ownedErr) throw ownedErr;

    for (const t of (ownedData ?? []) as IdRow[]) {
      const { error } = await admin.from('tenants').delete().eq('id', t.id);
      if (error) throw error;
    }

    await admin.from('tenant_members').delete().eq('user_id', user.id);

    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) throw delErr;

    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
