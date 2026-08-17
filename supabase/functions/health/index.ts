// Edge Function: health — health check PÚBLICO. SELF-CONTAINED (deployável pelo dashboard).
//
// Responde se o backend do Sir Barbecue está de pé:
//   • runtime das Edge Functions (se esta função respondeu, ele está no ar);
//   • Postgres — round-trip real via RPC public.saude_db()
//     (ver docs/banco-multi-cliente/MIGRATION_06_saude.sql).
//
// HTTP 200 = tudo ok. HTTP 503 = banco fora/lento. É o código de status que o
// monitor externo observa (ver docs/monitoramento/MONITOR_SAUDE.md).
//
// ATENÇÃO NO DEPLOY: esta é a ÚNICA função do projeto que vai SEM JWT —
//   supabase functions deploy health --no-verify-jwt
// (ou, pelo dashboard, desligar "Verify JWT" em Function Settings). Sem isso o
// monitor recebe 401 e vai alertar falha o tempo todo.
//
// Por ser pública, ela nunca devolve dado de cliente nem a mensagem crua do
// Postgres (que vazaria o schema) — só booleanos, latência e um código genérico.
// O erro completo vai para o log da função (Dashboard → Edge Functions → Logs).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VERSION = '2.1.0'; // manter em sincronia com o "version" do app.json
const DB_TIMEOUT_MS = 5_000; // acima disso consideramos o banco fora
const CACHE_MS = 5_000; // amortece rajadas: 1 check/min nunca pega cache

// CORS restrito. Diferente das outras funções, esta é chamada de dentro do NAVEGADOR
// (card de saúde do painel admin) — e o painel roda em mais de uma origem: produção
// (Netlify) e o localhost do dev. Por isso ALLOWED_ORIGIN aceita uma LISTA separada por
// vírgula e ecoamos de volta apenas a origem que bateu (nunca "*").
//   supabase secrets set ALLOWED_ORIGIN="https://sir-barbecue-admin.netlify.app,http://localhost:5173"
// Monitor externo e curl não mandam Origin nem fazem preflight — seguem funcionando com a
// variável vazia.
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
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };
}

// Opcional: se a env SAUDE_TOKEN estiver definida, exige ?token=<valor>.
// Desligada por padrão — o endpoint precisa ser aberto para o monitor externo.
const SAUDE_TOKEN = Deno.env.get('SAUDE_TOKEN') ?? '';

type Check = { ok: boolean; latency_ms: number; error?: string };

let cached: { at: number; check: Check } | null = null;

async function checkDatabase(): Promise<Check> {
  const startedAt = Date.now();
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!url || !anonKey) {
    console.error('[health] SUPABASE_URL/ANON_KEY ausentes no ambiente da função');
    return { ok: false, latency_ms: 0, error: 'config_missing' };
  }

  // Anon key de propósito: endpoint público não deve carregar a service_role.
  // A RPC é SECURITY DEFINER, então a anon consegue executá-la sem ler dado nenhum.
  const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    const { data, error } = await supabase.rpc('saude_db').abortSignal(controller.signal);
    const latency = Date.now() - startedAt;
    if (error) {
      console.error('[health] RPC saude_db falhou:', error.message, error.code ?? '');
      return { ok: false, latency_ms: latency, error: 'db_error' };
    }
    if ((data as { ok?: boolean } | null)?.ok !== true) {
      console.error('[health] RPC saude_db devolveu payload inesperado:', JSON.stringify(data));
      return { ok: false, latency_ms: latency, error: 'db_unexpected' };
    }
    return { ok: true, latency_ms: latency };
  } catch (e) {
    // Inclui o abort do timeout: banco lento demais conta como fora.
    console.error('[health] banco inacessível:', String((e as Error)?.message ?? e));
    return { ok: false, latency_ms: Date.now() - startedAt, error: 'db_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'GET, HEAD, OPTIONS' },
    });
  }

  if (SAUDE_TOKEN) {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    // 404 (e não 401) para não confirmar a existência do endpoint a quem varre.
    if (token !== SAUDE_TOKEN) return new Response('Not Found', { status: 404 });
  }

  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    cached = { at: now, check: await checkDatabase() };
  }
  const database = cached.check;

  // Corpo enxuto de propósito: alguns monitores gratuitos tratam respostas
  // grandes (>1 KB) como falha.
  const body = JSON.stringify({
    status: database.ok ? 'ok' : 'down',
    service: 'sir-barbecue',
    version: VERSION,
    checks: { edge: { ok: true }, database },
    ts: new Date().toISOString(),
  });

  return new Response(req.method === 'HEAD' ? null : body, {
    status: database.ok ? 200 : 503,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
});
