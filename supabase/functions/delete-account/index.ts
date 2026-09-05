// Edge Function: delete-account (RNF-08). SELF-CONTAINED (deployável pelo dashboard).
// Exclui a conta do usuário autenticado:
//  - apaga as empresas em que ele é o dono (cascade remove todos os dados + memberships);
//  - remove memberships restantes (onde é apenas membro);
//  - exclui o usuário do Auth.
// AÇÃO DESTRUTIVA E IRREVERSÍVEL.
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

type IdRow = { id: string };

/**
 * Apaga os relatórios da empresa no Storage.
 *
 * POR QUE ISTO EXISTE: o Postgres e o Storage são sistemas separados. Apagar a
 * empresa cascateia as linhas da tabela `reports`, mas NÃO remove os arquivos de
 * `reports/<tenant_id>/*.html`. Sem esta limpeza, o cliente exclui a conta e os
 * relatórios dele — faturamento, produtos vendidos, margem — ficam no bucket por
 * tempo indeterminado. A exclusão de conta é o RNF-08 (direito à eliminação):
 * cumpri-la só no banco é cumpri-la pela metade.
 * Ver "HTMLs órfãos" na seção 5 de docs/auditoria-seguranca-web/AUDITORIA_SEGURANCA_OWASP_2025.md.
 *
 * ORDEM IMPORTA: precisa rodar ANTES do delete da empresa. Depois dele não há
 * mais como descobrir quais pastas eram dela.
 *
 * Lista e apaga em rodadas, sempre do início: como cada rodada remove o que
 * listou, paginar por offset pularia arquivos (a lista encolhe a cada remoção).
 */
async function deleteTenantReports(admin: SupabaseClient, tenantId: string): Promise<void> {
  const BATCH = 100;
  const MAX_ROUNDS = 100; // teto de segurança: 10.000 arquivos por empresa

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data, error } = await admin.storage.from('reports').list(tenantId, { limit: BATCH });
    if (error) throw error;

    const names = (data ?? []).map((f) => `${tenantId}/${f.name}`);
    if (names.length === 0) return; // pasta vazia (ou já limpa) — fim

    const { error: rmErr } = await admin.storage.from('reports').remove(names);
    if (rmErr) throw rmErr;
  }

  // Chegar aqui significa que a listagem nunca esvaziou — provavelmente o remove
  // não está surtindo efeito. Melhor abortar (a conta NÃO é apagada, e o usuário
  // pode tentar de novo) do que seguir e deixar os arquivos órfãos de vez.
  throw new Error(`limpeza do bucket reports não terminou para o tenant ${tenantId}`);
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const json = jsonFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      password?: string;
      confirmText?: string;
    };

    const u = userClient(req);
    const { data } = await u.auth.getUser();
    const user = data.user;
    if (!user) return json({ error: 'Não autenticado.' }, 401);
    if (!user.email) return json({ error: 'Conta sem e-mail: fale com o suporte.' }, 400);

    // REAUTENTICAÇÃO. Antes, a única condição para destruir a empresa inteira
    // era ter uma sessão válida — e a sessão do PWA fica persistida no
    // localStorage do aparelho do balcão. Um token roubado, ou um clickjacking
    // sobre o botão, apagava tudo de forma irreversível (o DELETE em `tenants`
    // cascateia para produtos, vendas, estoque, comandas, relatórios e equipe:
    // leva junto o trabalho dos funcionários, não só o do dono).
    // Ver A06-03 na auditoria (docs/auditoria-seguranca-web).
    //
    // DOIS CAMINHOS, porque o app tem login com Google:
    //  • conta com senha (identity 'email') -> exige a senha, validada no servidor.
    //    É o que separa "tem o aparelho" de "é a pessoa".
    //  • conta só do Google -> NÃO EXISTE senha no GoTrue para validar. Exigir
    //    senha aqui trancaria esse usuário fora da própria exclusão de conta.
    //    A prova possível é de INTENÇÃO: digitar o próprio e-mail. Isso resolve o
    //    toque acidental e o clickjacking (que eram o cenário do A06-03); contra
    //    uma sessão roubada, quem entrou pelo Google não tem segredo local a
    //    provar — a reautenticação forte teria de ser um novo fluxo OAuth.
    // A lista de identities vazia (não devolvida) cai no caminho da senha: falha
    // fechada, nunca no caminho mais fraco.
    const identities = (user.identities ?? []) as { provider?: string }[];
    const hasPasswordIdentity =
      identities.length === 0 || identities.some((i) => i.provider === 'email');

    if (hasPasswordIdentity) {
      const password = (body.password ?? '').trim();
      if (!password) return json({ error: 'Informe sua senha para confirmar a exclusão.' }, 400);

      // Cliente separado e sem sessão: só valida a credencial, não mexe na sessão atual.
      const check = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { auth: { persistSession: false } },
      );
      const { error: pwdErr } = await check.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if (pwdErr) return json({ error: 'Senha incorreta.' }, 403);
    } else {
      const typed = (body.confirmText ?? '').trim().toLowerCase();
      if (typed !== user.email.trim().toLowerCase()) {
        return json({ error: 'Digite seu e-mail exatamente como aparece na tela.' }, 403);
      }
    }

    const admin = adminClient();

    const { data: ownedData, error: ownedErr } = await admin
      .from('tenants')
      .select('id')
      .eq('owner_user_id', user.id);
    if (ownedErr) throw ownedErr;

    for (const t of (ownedData ?? []) as IdRow[]) {
      // Storage ANTES do banco: depois do delete não há como saber que a pasta
      // era desta empresa. Se a limpeza falhar, o throw aborta tudo e a conta
      // permanece — melhor a exclusão falhar e ser repetida do que concluir
      // deixando os relatórios para trás.
      await deleteTenantReports(admin, t.id);

      const { error } = await admin.from('tenants').delete().eq('id', t.id);
      if (error) throw error;
    }

    await admin.from('tenant_members').delete().eq('user_id', user.id);

    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) throw delErr;

    return json({ ok: true });
  } catch (e) {
    // Ver A10-01: detalhe técnico no log da função, código de referência para o
    // usuário — nunca a mensagem crua do PostgREST/GoTrue.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[delete-account ${ref}]`, e);
    return json({ error: 'Não foi possível concluir a exclusão.', ref }, 400);
  }
});
