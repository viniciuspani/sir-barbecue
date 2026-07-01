# Edge Functions — Sir Barbecue (multi-tenant)

Funções **Deno/TypeScript** (Supabase Edge Functions). Não fazem parte do app React Native
(o `tsconfig`/`eslint` do app ignoram a pasta `supabase/`). O schema multi-tenant, RLS, triggers,
hook JWT e o bucket `reports` **já estão no banco**.

> **Deploy:** cada função é **self-contained** (1 só `index.ts`, sem imports de pasta-pai) — então
> dá para **colar o `index.ts` no editor do dashboard** ("Create new edge function") **ou** usar a
> CLI. (O padrão `_shared` com `../` só funciona na CLI, não no editor do dashboard — por isso o
> erro "Module not found .../_shared/utils.ts".)

| Função | O que faz | Quem chama |
|---|---|---|
| `generate-report` | Agrega vendas da empresa → gera **HTML** → sobe em `reports/<tenant_id>/` → registra linha em `reports` (RF-21/24/25/26) | usuário logado |
| `invite-member` | Owner adiciona membro **existente** ou **convida um novo por e-mail** (`tenant_members`) | owner |
| `delete-account` | Exclui a conta + empresas que o usuário possui (RNF-08) — **destrutivo** | usuário logado |
| `send-push` | Envia push (Expo) para uma lista de tokens | usuário logado / cron |

## Pré-requisitos
```bash
npm i -g supabase            # ou use o binário do Supabase CLI
supabase login
supabase link --project-ref <SEU_PROJECT_REF>
```
As funções recebem automaticamente `SUPABASE_URL`, `SUPABASE_ANON_KEY` e
`SUPABASE_SERVICE_ROLE_KEY` no ambiente — **não** precisa configurar secrets para estas 4.

## Deploy
```bash
supabase functions deploy generate-report
supabase functions deploy invite-member
supabase functions deploy delete-account
supabase functions deploy send-push
```
> `verify_jwt` fica **ligado** por padrão (exige usuário autenticado) — correto para as 4.
> Quando a `send-push` passar a ser chamada por cron/trigger (infra de push, abaixo), use
> `supabase functions deploy send-push --no-verify-jwt` (ou chame com o `service_role`).

## Como o app chama (exemplos)
```ts
// Relatório → retorna { path }; gere uma signed URL para abrir/baixar (bucket é privado):
const { data } = await supabase.functions.invoke('generate-report', {
  body: { type: 'monthly_sales' }, // ou daily_sales | products_sold | financial_summary
});
const { data: signed } = await supabase.storage
  .from('reports').createSignedUrl(data.path, 3600);
// abrir signed.signedUrl em WebView/navegador.

// Convidar membro (owner):
await supabase.functions.invoke('invite-member', { body: { email, role: 'employee' } });

// Excluir conta (após confirmação):
await supabase.functions.invoke('delete-account');

// Enviar push (tokens explícitos):
await supabase.functions.invoke('send-push', { body: { tokens, title, body, data } });
```

## Notas por função
- **generate-report** — período padrão = mês atual (aceita `from`/`to` ISO). Sobe HTML em
  `reports/<tenant_id>/<id>.html` (a policy `reports_tenant_read` libera leitura por empresa).
  PDF é evolução futura (Deno não tem Chrome headless → exige serviço externo).
- **invite-member** — adiciona um **usuário existente** OU **convida um novo por e-mail**
  (`inviteUserByEmail` com `invited_to_tenant`). O novo usuário é vinculado à empresa que convidou
  pelo trigger `handle_new_user_invite`. **Pré-requisito:** aplicar
  `docs/banco-multi-cliente/MIGRATION_01_invite_trigger.sql` (guarda no `handle_new_user` + novo
  `handle_new_user_invite`).
- **delete-account** — irreversível. Apaga as empresas onde é owner (cascade) + memberships + o
  usuário no Auth.
- **send-push** — sender puro. O lookup de tokens por usuário e os disparos automáticos exigem a
  infra abaixo.

## Infra de push (RF-11) — IMPLEMENTADA
- **Tabela `push_tokens`** + RLS + **trigger `notify_low_stock`**: aplicar
  `docs/banco-multi-cliente/MIGRATION_02_push_tokens.sql` (habilita `pg_net` e dispara o push direto
  na **Expo Push API** quando o estoque fica baixo — endpoint público, sem segredo no banco).
- **App** salva o token em `push_tokens` (`src/services/push.ts`): no botão "Ativar notificações" e,
  silenciosamente, no boot após login (se a permissão já foi concedida). Exige **development build**
  (não funciona no Expo Go).
- **`send-push` v2** aceita `tokens` explícitos **ou** `tenant_id` (resolve os tokens da empresa) —
  redeploy: `supabase functions deploy send-push`.

> **RF-22 (relatório pronto):** como a geração é síncrona (o usuário já vê o resultado), esse push é
> opcional — dá para a `generate-report` chamar `send-push` com `tenant_id` ao final, se quiser.

## Teste local
```bash
supabase functions serve            # serve todas localmente
# chame http://localhost:54321/functions/v1/generate-report com o header Authorization: Bearer <jwt>
```
