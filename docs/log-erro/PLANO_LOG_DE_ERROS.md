# Log de erros com registro em banco e mensagem amigável ao usuário

## Contexto

Hoje o app **perde todo erro que acontece**. Existem 52 blocos `catch` em 29 arquivos e a maioria
engole a falha em silêncio (`.catch(() => undefined)`, ex.: `app/(app)/estoque/detalhe.tsx:44`) ou
só imprime no console (`src/data/sync/syncEngine.ts:525`), que ninguém lê em produção. O
`@sentry/react-native` está no `package.json:24` mas **nunca foi inicializado**. Resultado: quando um
cliente relata "deu erro", não há como saber o que aconteceu, em qual tela, nem com qual mensagem.

O objetivo é: **toda falha gera um registro** com data/hora, o que o usuário estava fazendo (tela +
ação + últimos passos) e a mensagem técnica completa; esse registro fica no banco para consulta
posterior **no painel web admin**; e o usuário vê apenas uma **mensagem educada, clara e objetiva**,
acompanhada de um **código de referência** curto que localiza o registro exato no log (o cliente te
passa "Código: 7F3A" e você acha a ocorrência).

Restrição central: **o app é offline-first**. Erro que acontece sem internet é justamente o mais
importante, então o log grava **primeiro no SQLite local** e sobe para o Supabase pelo `syncEngine`,
seguindo o mesmo padrão `needs_sync`/`synced_at` das demais tabelas.

---

## Fase 1 — Armazenamento local

**`src/data/local/schema.ts`** — nova tabela `errorLogs` (`error_logs`):

| coluna | tipo | conteúdo |
|---|---|---|
| `id` | text PK | UUID = `client_id` (idempotência do push) |
| `refCode` | text | código curto mostrado ao usuário (6 chars, sem `0/O/1/I`) |
| `occurredAt` | integer | epoch ms — **data e hora** |
| `severity` | text | `'error'` \| `'fatal'` |
| `screen` | text | rota no momento (ex.: `/venda/fechar`) |
| `action` | text | **o que o usuário estava fazendo** (ex.: `Fechar venda`) |
| `context` | text (JSON) | breadcrumbs (últimos passos), `isOnline`, papel, params não sensíveis |
| `message` | text | mensagem curta do erro |
| `detail` | text | **mensagem completa**: stack + `code`/`details`/`hint` do Postgres/Supabase |
| `userMessage` | text | o que foi exibido ao usuário |
| `userId`, `tenantId` | text (nullable) | podem ser nulos: erro antes do login/vínculo |
| `appVersion`, `platform`, `osVersion` | text | ambiente |
| `needsSync`, `syncedAt` | | padrão de sync do projeto |

**`src/data/local/database.ts`** — `CREATE TABLE IF NOT EXISTS error_logs (...)` no bloco de bootstrap
+ índices `(needs_sync)` e `(occurred_at DESC)`. Não precisa de migração incremental (tabela nova).

Teto de retenção local: ao inserir, podar registros já sincronizados com mais de 30 dias e manter no
máximo 500 linhas — o log nunca pode inchar o banco do PDV.

## Fase 2 — Núcleo do log

**`src/services/breadcrumbs.ts`** (novo) — buffer circular em memória com os últimos ~20 passos.
`trackScreen(rota)` e `trackAction(label)`. É isto que responde "o que o usuário estava fazendo" —
sem ele o log só tem a tela final, não o caminho.

**`src/services/errorLog.ts`** (novo) — coração da funcionalidade:
- `logError(error, { action, screen?, severity?, meta? }): Promise<string>` → grava e devolve o `refCode`.
- Normaliza qualquer formato de erro: `Error` (message + stack), `PostgrestError` (`message`, `code`,
  `details`, `hint`), `AuthError`, string, objeto solto.
- **Redação (LGPD)**: antes de gravar, mascara chaves sensíveis por regex — `password`, `access_token`,
  `refresh_token`, `apikey`, `authorization`, `Bearer ...`. Nunca gravar credencial no log.
- **Nunca lança**: todo o corpo em `try/catch` com fallback para `console.warn`. Falha no logger não
  pode derrubar a tela.
- Preenche automaticamente: `occurredAt`, tela atual (breadcrumbs), `userId`/`tenantId`/papel via
  `useAuthStore.getState()` (mesmo padrão preguiçoso de `src/lib/activeTenant.ts`), versão via
  `expo-application` (já usado em `src/services/access.ts`), plataforma/OS via `Platform`.

**`src/lib/errors.ts`** (novo) — catálogo de mensagens amigáveis. `toUserMessage(error, action?)`
mapeia assinaturas conhecidas para PT-BR claro e objetivo:

| assinatura | mensagem ao usuário |
|---|---|
| `Network request failed` / offline | "Sem conexão no momento. Seus dados ficam salvos no aparelho e enviamos assim que a internet voltar." |
| `42501` / `row-level security` / `permission denied` | "Seu perfil não tem permissão para essa ação. Fale com o dono ou o gerente." |
| `stock_items_quantity_check` | "Estoque insuficiente para concluir a venda. Confira o saldo do produto." |
| `23505` (unique) | "Já existe um cadastro com esse nome." |
| `Invalid login credentials` | "E-mail ou senha incorretos. Confira e tente de novo." |
| fallback | "Não foi possível concluir *\<ação\>*. Já registramos o ocorrido — tente novamente em instantes." |

Reaproveita a lógica de `isPermissionError` que hoje vive isolada em `syncEngine.ts:511`
(passa a importar daqui).

**`src/lib/feedback.ts`** (novo, ao lado do `src/lib/toast.ts` existente):
- `showErrorAlert(userMessage, refCode)` → `Alert.alert` com título curto, corpo = mensagem +
  `\n\nCódigo: 7F3A`, botão **OK**.
- `reportError(error, { action })` → `logError` + `showErrorAlert`. **É o helper de uma linha que as
  telas chamam no `catch`.**
- `logSilently(error, { action })` → só grava, sem alerta (carga de tela, sync em background).

## Fase 3 — Captura automática

**`src/services/errorHandlers.ts`** (novo), instalado uma vez em `app/_layout.tsx`:
- `ErrorUtils.setGlobalHandler` → crash JS não tratado, `severity: 'fatal'` (encadeia o handler
  anterior para não quebrar o LogBox em dev).
- Rejeições de promise não tratadas via `promise/setimmediate/rejection-tracking` (caminho padrão no
  React Native), dentro de `try/catch` caso o módulo não esteja disponível.
- `export function ErrorBoundary({ error, retry })` em **`app/_layout.tsx`** — o Expo Router usa esse
  export por arquivo de rota. Grava o log e substitui a tela branca por uma tela amigável com o
  código de referência e botão "Tentar novamente".
- Hook `useRouteBreadcrumb()` (`usePathname`) no root layout alimentando `trackScreen`.

**Pontos de estrangulamento** — dão cobertura ampla sem instrumentar 29 arquivos um a um:
- `runStep` em `src/data/sync/syncEngine.ts:519` → troca o `console.warn` por `logSilently` com
  `action: 'Sincronizar (${label})'`. Sync é background: grava, não alerta.
- `callFunction` em `src/services/functions.ts:8` → toda falha de Edge Function vira log.
- `init`/`resolveMembership` em `src/store/authStore.ts:192` → hoje `console.warn`.

**Telas** — substituição mecânica (1 linha por ponto) dos `catch` silenciosos: `reportError` quando a
falha é consequência de uma ação do usuário (salvar, fechar venda, excluir); `logSilently` quando é
carga de tela. Arquivos representativos: `app/(app)/venda/fechar.tsx`, `app/(app)/produtos/form.tsx`,
`app/(app)/estoque/detalhe.tsx`, `app/(app)/mais/fornecedor-form.tsx`, `app/(app)/mais/empresa.tsx`,
e os repositórios em `src/data/repositories/`.

## Fase 4 — Sync e banco no Supabase

**`src/data/sync/syncEngine.ts`** — nova etapa `pushErrorLogs(tenantId)`, última dos pushes:
- Envia em lote os logs com `needs_sync = 1` (upsert por `client_id`, idempotente).
- **Diferente das demais etapas, não filtra por tenant na origem**: logs gravados antes do login/vínculo
  sobem carimbados com o usuário e a empresa ativos no envio, e o `context` marca `preAuth: true`.
  Sem isso, justamente os erros de login — os mais críticos — nunca chegariam ao servidor.
- Roda para **todos os papéis** (qualquer usuário grava o próprio log; a RLS garante isso).
- Guarda `isPushingLogs` para que uma falha no push de log **nunca gere outro log** (evita loop).

**`docs/banco-multi-cliente/MIGRATION_05_error_logs.sql`** (novo, idempotente, no padrão dos demais):
- Tabela `public.error_logs` espelhando o schema local. `tenant_id` **nullable** (erro pré-vínculo);
  `user_id` com `default auth.uid()`.
- RLS: `insert` com `with check (user_id = auth.uid())`; `select` para `public.is_platform_admin()`
  (painel) ou `public.is_tenant_owner(tenant_id)` — helpers já existentes no schema multi-tenant.
- Índices: `(tenant_id, occurred_at desc)`, `(ref_code)`, `(severity, occurred_at desc)`.
- RPCs no padrão `admin_*` (validam `is_platform_admin()`, retornam jsonb camelCase, como
  `admin_list_tenants_overview` em `docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql:337`):
  - `admin_list_error_logs(p_tenant_id, p_severity, p_search, p_limit, p_offset)` — `p_search` casa
    com `ref_code`, `action` ou `message`.
  - `admin_error_log_detail(p_id)` — registro completo com stack e contexto.
  - `admin_run_error_logs_cleanup(p_days default 90)` — purga por retenção, no espírito do
    `admin_run_price_history_cleanup` já existente.

> Aplicação da migração no Supabase é manual (SQL Editor), como as anteriores.

## Fase 5 — Consulta no painel web admin

> ⚠️ **Outro repositório**: `c:\develop\WEB\sir-barbecue-admin` (fora do diretório de trabalho deste
> projeto, mesmo Supabase). Foi a superfície de consulta que você escolheu, então está no escopo.

- `src/hooks/useAdmin.ts` → `useErrorLogs(filtros)` e `useErrorLogDetail(id)`, no mesmo padrão
  react-query + `USE_MOCK` dos hooks existentes.
- `src/pages/Erros.tsx` (novo) — tabela com data/hora, empresa, usuário, tela/ação, mensagem e código;
  filtros por empresa e severidade + busca pelo código de referência; painel lateral de detalhe com a
  mensagem completa, o stack e os últimos passos do usuário.
- `src/components/Layout.tsx:8` → novo item de nav "Erros".
- `src/App.tsx` → rota `/erros`. `src/types.ts` → `ErrorLog`/`ErrorLogDetail`. `src/lib/mock.ts` →
  dados de mock para o modo sem backend.

---

## Verificação

1. `npm run typecheck` e `npm run lint` no app.
2. Aplicar `MIGRATION_05_error_logs.sql` no SQL Editor do Supabase (roda duas vezes: idempotente).
3. **Erro tratado**: com o app rodando, forçar falha ao salvar um produto (ex.: derrubar a rede no
   meio) → deve aparecer o Alert educado **com código**; conferir a linha em `error_logs` local
   (`npx drizzle-kit studio` ou consulta direta) com `action`, `screen` e stack preenchidos.
4. **Erro offline → sync**: gerar o erro em modo avião, reconectar, aguardar o `runSync` e conferir
   que a linha chegou em `public.error_logs` com o `tenant_id` correto.
5. **Crash global**: lançar um erro proposital no render de uma tela → `ErrorBoundary` mostra a tela
   amigável com código, e o registro sai com `severity = 'fatal'`.
6. **Erro pré-login**: errar a senha no login → log gravado sem `tenant_id`; após o login bem-sucedido,
   confirmar que subiu com `preAuth: true` no contexto.
7. **Permissão**: logar como `employee` e tentar uma escrita de catálogo → mensagem "Seu perfil não tem
   permissão…" e log com o código `42501` no detalhe.
8. **Painel**: `npm run dev` no admin, abrir `/erros`, filtrar pelo código gerado no passo 3 e conferir
   que o detalhe traz a mensagem completa.
9. **Não regressão**: confirmar que uma falha no push de log não marca o sync inteiro como erro
   (`runStep` isola) e que nenhum log é gerado a partir da própria falha de envio de log.

---

## Status da implementação (executado)

Todas as 5 fases foram implementadas. `npm run typecheck` e `npm run lint` passam no app;
`npm run build` passa no painel. Diferenças em relação ao plano original, todas por robustez:

- **Deduplicação por assinatura, com janela configurável** (`dedupeMs` em `LogOptions`). O plano
  previa um guard simples de reentrância, que descartaria erros *diferentes* ocorridos ao mesmo
  tempo — uma tela que dispara 5 consultas em paralelo pode falhar em todas, e as 5 importam. As
  etapas de sync usam janela de 1 h porque o ciclo repete a cada 5 min.
- **`user_id` do push vem da sessão** (`data.session.user.id`), não do `authStore`: a RLS exige
  `user_id = auth.uid()` e o store pode estar um passo atrás numa troca de conta.
- **Política de UPDATE na RLS**: o push é upsert por `client_id` (reenvio idempotente), então o
  usuário precisa poder reescrever a própria linha.
- **Bugs corrigidos de passagem**: `onSave` de produto/fornecedor e `onConfirm` da venda não tinham
  `try/catch` — uma falha deixava o botão travado em "carregando" para sempre. Agora usam `finally`.

### Backend

`docs/banco-multi-cliente/MIGRATION_05_error_logs.sql` — ✅ **aplicada no Supabase em 2026-08-15**.
Tabela, RLS e as três RPCs `admin_*` estão no ar; o push do `syncEngine` já tem para onde enviar.

## Fora do escopo (registrado)

- **Sentry**: continua instalado e não inicializado. O `logError` é o ponto único onde um
  `Sentry.captureException` entraria depois, em uma linha — mas não faz parte desta entrega.
- Tela de diagnóstico dentro do app (você optou por consultar pelo painel web).
