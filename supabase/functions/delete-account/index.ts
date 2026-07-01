// Edge Function: delete-account (RNF-08). SELF-CONTAINED (deployável pelo dashboard).
// Exclui a conta do usuário autenticado:
//  - apaga as empresas em que ele é o dono (cascade remove todos os dados + memberships);
//  - remove memberships restantes (onde é apenas membro);
//  - exclui o usuário do Auth.
// AÇÃO DESTRUTIVA E IRREVERSÍVEL.
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

type IdRow = { id: string };

Deno.serve(async (req: Request) => {
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
