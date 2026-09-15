// Edge Function: delete-account (RNF-08). SELF-CONTAINED (deployável pelo dashboard).
//
// MUDANÇA IMPORTANTE (MIGRATION_24): esta função NÃO apaga mais nada quando quem
// chama é DONO de empresa. Ela AGENDA a exclusão:
//  - dono de empresa  -> grava uma linha em `account_deletion_requests` com data
//    marcada (48h sem exportação, 10 dias úteis com) e devolve a data. A empresa
//    entra em SOMENTE-LEITURA na hora (tenant_has_access passa a ser false).
//    Quem executa de fato, na data, é a `process-deletion-requests`.
//  - apenas MEMBRO    -> caminho antigo, inalterado e imediato: INATIVA o vínculo
//    (`removed_at`, MIGRATION_21 — a linha é o ator do histórico do patrão) e
//    exclui o usuário do Auth. Exportação, janela de arrependimento e contato de
//    retenção só fazem sentido para o titular da empresa.
//
// POR QUE AGENDAR: a exclusão imediata levava o cliente embora sem nenhuma janela
// para o dono do SaaS ligar e tentar reverter o cancelamento, e não havia caminho
// de portabilidade acoplado à saída (LGPD). Plano completo:
// docs/exportacao-dados/PLANO_EXCLUSAO_AGENDADA.md.
//
// DEPLOY:
//   supabase functions deploy delete-account
//
// Versão EXATA (não `@2`): sem lockfile, `@2` resolveria para a última 2.x no
// momento de cada deploy — e este código roda com a SERVICE_ROLE_KEY no ambiente.
// Ver A03-01 na auditoria (docs/auditoria-seguranca-web).
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.4';

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

type TenantRow = { id: string; name: string };

type RequestBody = {
  password?: string;
  confirmText?: string;
  exportRequested?: boolean;
  contactName?: string;
  contactPhone?: string;
  localPending?: number;
};

type User = { id: string; email?: string | null; identities?: { provider?: string }[] | null };

// Limite defensivo: estes campos vão para o painel do dono e para o e-mail.
const MAX_CONTACT = 120;

/**
 * REAUTENTICAÇÃO. Antes, a única condição para destruir a empresa inteira era ter
 * uma sessão válida — e a sessão do PWA fica persistida no localStorage do
 * aparelho do balcão. Um token roubado, ou um clickjacking sobre o botão, apagava
 * tudo de forma irreversível. Ver A06-03 na auditoria (docs/auditoria-seguranca-web).
 *
 * Continua valendo com o agendamento: uma solicitação forjada joga a empresa em
 * SOMENTE-LEITURA na hora — ou seja, derruba a operação do balcão mesmo sem
 * apagar nada. A prova de identidade é o que impede isso.
 *
 * DOIS CAMINHOS, porque o app tem login com Google:
 *  • conta com senha (identity 'email') -> exige a senha, validada no servidor.
 *    É o que separa "tem o aparelho" de "é a pessoa".
 *  • conta só do Google -> NÃO EXISTE senha no GoTrue para validar. Exigir senha
 *    trancaria esse usuário fora da própria exclusão de conta. A prova possível é
 *    de INTENÇÃO: digitar o próprio e-mail.
 * A lista de identities vazia cai no caminho da senha: falha fechada, nunca no
 * caminho mais fraco.
 *
 * Devolve `{ error, status }` quando reprova, ou `null` quando passa.
 */
async function reauthenticate(
  user: User,
  body: RequestBody,
): Promise<{ error: string; status: number } | null> {
  const email = user.email ?? '';
  const identities = (user.identities ?? []) as { provider?: string }[];
  const hasPasswordIdentity =
    identities.length === 0 || identities.some((i) => i.provider === 'email');

  if (!hasPasswordIdentity) {
    const typed = (body.confirmText ?? '').trim().toLowerCase();
    if (typed !== email.trim().toLowerCase()) {
      return { error: 'Digite seu e-mail exatamente como aparece na tela.', status: 403 };
    }
    return null;
  }

  const password = (body.password ?? '').trim();
  if (!password) {
    return { error: 'Informe sua senha para confirmar a exclusão.', status: 400 };
  }

  // Cliente separado e sem sessão: só valida a credencial, não mexe na sessão atual.
  const check = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { auth: { persistSession: false } },
  );
  const { error: pwdErr } = await check.auth.signInWithPassword({ email, password });
  if (pwdErr) return { error: 'Senha incorreta.', status: 403 };
  return null;
}

/**
 * Caminho do DONO: agenda em vez de apagar. Devolve o corpo da resposta e o status.
 */
async function scheduleDeletion(
  admin: SupabaseClient,
  user: User,
  owned: TenantRow[],
  body: RequestBody,
): Promise<{ payload: Record<string, unknown>; status: number }> {
  // TRAVA DO SYNC (trava 1 de duas). Esta função roda no SERVIDOR e não alcança o
  // SQLite do aparelho: quem consegue subir a venda registrada offline é só o app.
  // Se agendássemos com linha pendente no aparelho, essa venda seria destruída sem
  // nunca ter subido. O app empurra o sync antes de chamar e informa aqui quanto
  // sobrou; a trava 2 são as policies *_drain_insert (MIGRATION_24), que deixam o
  // sync de OUTROS aparelhos terminar de drenar durante a janela.
  const localPending = Number(body.localPending ?? 0);
  if (Number.isFinite(localPending) && localPending > 0) {
    return {
      payload: {
        error: 'Há vendas ainda não enviadas neste aparelho. Conecte-se à internet e tente de novo.',
      },
      status: 409,
    };
  }

  const contactName = (body.contactName ?? '').trim().slice(0, MAX_CONTACT);
  const contactPhone = (body.contactPhone ?? '').trim().slice(0, MAX_CONTACT);
  if (!contactName) {
    return { payload: { error: 'Informe o nome de quem podemos procurar.' }, status: 400 };
  }
  if (!contactPhone) {
    return { payload: { error: 'Informe um telefone de contato.' }, status: 400 };
  }

  const exportRequested = body.exportRequested === true;

  // As DUAS datas vêm do servidor (relógio do aparelho é manipulável, e os três
  // clientes não podem divergir da data efetivamente gravada).
  const { data: preview, error: prevErr } = await admin.rpc('deletion_request_preview');
  if (prevErr) throw prevErr;
  const dates = (preview ?? {}) as { dateNoExport?: string; dateWithExport?: string };
  const scheduledFor = exportRequested ? dates.dateWithExport : dates.dateNoExport;
  if (!scheduledFor) throw new Error('deletion_request_preview não devolveu as datas');

  // Idempotente: uma solicitação pendente por empresa (índice parcial
  // uq_deletion_request_pending). Se o usuário tocar duas vezes, ou se o app
  // reenviar, devolvemos a que já existe em vez de estourar no índice.
  const ownedIds = owned.map((t) => t.id);
  const { data: existingData, error: existErr } = await admin
    .from('account_deletion_requests')
    .select('tenant_id, scheduled_for, export_requested')
    .in('tenant_id', ownedIds)
    .eq('status', 'pending');
  if (existErr) throw existErr;

  const existing = (existingData ?? []) as {
    tenant_id: string;
    scheduled_for: string;
    export_requested: boolean;
  }[];
  const alreadyPending = new Set(existing.map((r) => r.tenant_id));

  const toInsert = owned
    .filter((t) => !alreadyPending.has(t.id))
    .map((t) => ({
      tenant_id: t.id,
      tenant_name: t.name,
      requested_by: user.id,
      export_requested: exportRequested,
      scheduled_for: scheduledFor,
      status: 'pending',
      export_status: exportRequested ? 'pending' : 'not_requested',
      contact_name: contactName,
      contact_phone: contactPhone,
      contact_email: user.email,
    }));

  if (toInsert.length > 0) {
    const { error: insErr } = await admin.from('account_deletion_requests').insert(toInsert);
    if (insErr) throw insErr;
  }

  // Se tudo já estava pendente, devolve a data da solicitação EXISTENTE — o app
  // precisa mostrar a data real, não a que teria sido calculada agora.
  const effectiveDate = toInsert.length > 0 ? scheduledFor : existing[0]?.scheduled_for ?? scheduledFor;
  const effectiveExport =
    toInsert.length > 0 ? exportRequested : existing[0]?.export_requested ?? exportRequested;

  // NÃO desloga e NÃO apaga: a janela de arrependimento só existe se o cliente
  // continuar entrando no app para ver o aviso e o botão de cancelar.
  return {
    payload: {
      ok: true,
      deleted: false,
      scheduled: true,
      scheduledFor: effectiveDate,
      exportRequested: effectiveExport,
      alreadyExisted: toInsert.length === 0,
    },
    status: 200,
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const json = jsonFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;

    const u = userClient(req);
    const { data } = await u.auth.getUser();
    const user = data.user as User | null;
    if (!user) return json({ error: 'Não autenticado.' }, 401);
    if (!user.email) return json({ error: 'Conta sem e-mail: fale com o suporte.' }, 400);

    const denied = await reauthenticate(user, body);
    if (denied) return json({ error: denied.error }, denied.status);

    const admin = adminClient();

    const { data: ownedData, error: ownedErr } = await admin
      .from('tenants')
      .select('id, name')
      .eq('owner_user_id', user.id);
    if (ownedErr) throw ownedErr;

    const owned = (ownedData ?? []) as TenantRow[];

    // ── CAMINHO 2: não é dono de nada — exclusão imediata, como sempre foi ─────
    if (owned.length === 0) {
      // SOFT DELETE do vínculo (MIGRATION_21), não DELETE. A linha de
      // `tenant_members` é o ATOR para o qual as vendas, entradas de estoque e
      // relatórios daquela empresa apontam (FKs compostas `*_actor_fkey`):
      // apagá-la quebraria a integridade do histórico do PATRÃO, que não pediu
      // exclusão nenhuma. `removed_at` preserva o vínculo como marcador opaco —
      // sem nome, e-mail ou telefone — e faz `user_tenant_ids()` parar de
      // devolver a empresa.
      const { error: memberErr } = await admin
        .from('tenant_members')
        .update({ removed_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .is('removed_at', null);
      if (memberErr) throw memberErr;

      const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
      if (delErr) throw delErr;

      return json({ ok: true, deleted: true, scheduled: false });
    }

    // ── CAMINHO 1: é dono — AGENDA, não apaga ─────────────────────────────────
    const scheduled = await scheduleDeletion(admin, user, owned, body);
    return json(scheduled.payload, scheduled.status);
  } catch (e) {
    // Ver A10-01: detalhe técnico no log da função, código de referência para o
    // usuário — nunca a mensagem crua do PostgREST/GoTrue.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[delete-account ${ref}]`, e);
    return json({ error: 'Não foi possível concluir a solicitação.', ref }, 400);
  }
});
