// Edge Function: send-push. SELF-CONTAINED (deployável pelo dashboard).
// Envia notificações via Expo Push API. Aceita tokens explícitos OU um tenant_id
// (resolve os tokens da empresa em push_tokens, usando service_role).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
      tokens?: string[];
      tenant_id?: string;
      title?: string;
      body?: string;
      data?: Record<string, unknown>;
    };

    let tokens = (body.tokens ?? []).filter((t) => typeof t === 'string' && t.length > 0);

    // Sem tokens explícitos + tenant_id → resolve os tokens da empresa.
    if (tokens.length === 0 && body.tenant_id) {
      const admin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        { auth: { persistSession: false } },
      );
      const { data } = await admin.from('push_tokens').select('token').eq('tenant_id', body.tenant_id);
      tokens = ((data ?? []) as { token: string }[]).map((r) => r.token);
    }

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
