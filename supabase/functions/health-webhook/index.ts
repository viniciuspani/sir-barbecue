// Edge Function: health-webhook. SELF-CONTAINED (deployável pelo dashboard).
//
// Recebe as notificações de queda/retorno do monitor externo (HetrixTools) e grava
// em public.health_events — é o que dá HISTÓRICO ao painel admin ("caiu 03:12,
// voltou 03:19"). O /health só sabe do agora; quem sabe do passado é isto aqui.
//
// Fluxo: HetrixTools detecta → POST neste endpoint → linha em health_events →
//        painel lê via RPC admin_list_health_events / admin_health_summary.
//
// Pré-requisito: docs/banco-multi-cliente/MIGRATION_07_health_events.sql.
//
// DEPLOY (sem JWT — o HetrixTools não tem como autenticar no Supabase):
//   supabase secrets set SAUDE_WEBHOOK_TOKEN="<gere um segredo longo e aleatório>"
//   supabase functions deploy health-webhook --no-verify-jwt
//
// SEGURANÇA: diferente do /health (que só LÊ), esta função ESCREVE — sem o token
// qualquer um forjaria quedas no seu histórico. Por isso ela é fail-closed: se a
// env SAUDE_WEBHOOK_TOKEN não estiver configurada, ela recusa tudo em vez de
// aceitar tudo. O token vai na querystring porque é o que o HetrixTools permite
// configurar (a URL do webhook) — trafega dentro do TLS.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const WEBHOOK_TOKEN = Deno.env.get('SAUDE_WEBHOOK_TOKEN') ?? '';

// Payload do HetrixTools (ver docs deles: Uptime Monitoring Webhook Notifications).
type HetrixPayload = {
  monitor_id?: string;
  monitor_name?: string;
  monitor_target?: string;
  monitor_status?: string; // 'online' | 'offline'
  timestamp?: number | string; // unix (segundos)
  monitor_errors?: unknown;
};

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** Aceita JSON (padrão) e form-urlencoded, para não depender do formato do provedor. */
async function parseBody(req: Request): Promise<HetrixPayload> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HetrixPayload;
  } catch {
    const params = new URLSearchParams(raw);
    const obj: Record<string, string> = {};
    for (const [k, v] of params) obj[k] = v;
    return obj as HetrixPayload;
  }
}

/** monitor_errors vem como array; normalizamos para array de strings legíveis. */
function normalizeErrors(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).slice(0, 30);
  }
  if (typeof input === 'string' && input.trim()) return [input.trim()];
  return [];
}

Deno.serve(async (req: Request) => {
  // Fail-closed: sem segredo configurado, ninguém escreve.
  if (!WEBHOOK_TOKEN) {
    console.error('[health-webhook] SAUDE_WEBHOOK_TOKEN não configurada — recusando tudo.');
    return textResponse('not configured', 503);
  }

  const token = new URL(req.url).searchParams.get('token') ?? '';
  // 404 para não confirmar a existência do endpoint a quem varre.
  if (token !== WEBHOOK_TOKEN) return textResponse('Not Found', 404);

  if (req.method !== 'POST') return textResponse('method not allowed', 405);

  try {
    const payload = await parseBody(req);
    const status = String(payload.monitor_status ?? '').toLowerCase();
    if (status !== 'online' && status !== 'offline') {
      console.error('[health-webhook] monitor_status inesperado:', status);
      return textResponse('invalid status', 400);
    }

    // timestamp unix em segundos; se vier ausente/estranho, usa a hora de agora.
    const unix = Number(payload.timestamp);
    const occurredAt =
      Number.isFinite(unix) && unix > 0
        ? new Date(unix * 1000).toISOString()
        : new Date().toISOString();

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    );

    const { error } = await admin.from('health_events').insert({
      monitor_id: payload.monitor_id ?? null,
      monitor_name: payload.monitor_name ?? 'monitor',
      monitor_target: payload.monitor_target ?? null,
      status,
      occurred_at: occurredAt,
      errors: normalizeErrors(payload.monitor_errors),
      raw: payload,
    });

    // 23505 = reentrega do mesmo evento (índice health_events_dedup_idx). Não é erro:
    // responder 200 evita que o monitor fique retentando para sempre.
    if (error && error.code !== '23505') {
      console.error('[health-webhook] falha ao gravar:', error.message, error.code ?? '');
      return textResponse('insert failed', 500);
    }

    return textResponse('ok', 200);
  } catch (e) {
    console.error('[health-webhook] erro inesperado:', String((e as Error)?.message ?? e));
    return textResponse('bad request', 400);
  }
});
