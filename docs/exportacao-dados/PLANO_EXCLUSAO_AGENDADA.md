# Exclusão de conta agendada + solicitação de exportação de dados

> **STATUS (15/09/2026): EM PRODUÇÃO, verificado ponta a ponta.**
> MIGRATION_24 aplicada, as 3 Edge Functions publicadas, Vault + cron horário +
> webhook do Resend configurados. Testado com a empresa de teste "Espetinho Pani",
> que foi realmente excluída no teste.
>
> **O que o teste em produção provou:** 22/22 no teste funcional de RLS via API
> (dreno do sync, escrita travada, mensagem certa no `create_sale`, cancelamento
> devolvendo a escrita); webhook do Resend confirmando entrega em ~3 s (assinatura
> Svix válida em produção); exclusão acontecendo só na passada SEGUINTE, com
> `delivered` confirmado; `completed_at` às 02:00:02 UTC, ou seja o `pg_cron`
> horário executando sozinho pela cadeia Vault → pg_net → Edge Function; histórico
> preservado com contato anonimizado (inclusive na solicitação CANCELADA); e a
> limpeza do Storage varrendo a pasta do tenant sem levar o zip de `deletions/`.
>
> **Pendente:** ver numa caixa de entrada o e-mail com o assunto/corpo NOVOS
> (link de 30 dias, texto puro). O código está publicado, mas o cron apagou a
> conta de teste antes de dar para conferir o formato — exige conta nova.
>
> **Achado de produto:** o e-mail caiu na aba Promoções do Gmail mesmo com
> SPF/DKIM/DMARC corretos. Como ele carrega a única cópia dos dados do cliente,
> isso motivou a reescrita transacional e o link de 30 dias.
>
> **Verificado antes, localmente:** MIGRATION_24 num Postgres 16 descartável
> (feriados, dias úteis, anonimização, idempotência); `deno check` nas 3 functions;
> HMAC conferido contra o vetor oficial do Svix; `tsc`+`eslint` no mobile;
> `tsc`+188 testes+build no PWA; `tsc`+build no painel.
>
> **Três decisões do plano mudaram durante a implementação** — D7 (revertida, ver
> abaixo), o `readOnly` fora da matriz de permissões do PWA, e os `canWrite*` do
> mobile voltando a depender só do papel. Cada uma está justificada no ponto.

## Contexto

Hoje a exclusão de conta é **imediata e irreversível**: o cliente confirma a senha, a
`delete-account` roda `delete_tenant_cascade` e a empresa some na hora. Isso tem dois custos:

1. **Comercial** — quando o cliente cancela a assinatura excluindo a conta, o dono do SaaS não
   tem nenhuma janela para ligar, entender o motivo e tentar reverter. O cliente vai embora sem
   contato.
2. **LGPD** — não existe caminho de portabilidade acoplado à saída. A exportação existe
   (`exportar-dados`), mas é self-service e quem sai com raiva não passa por ela.

A mudança transforma a exclusão numa **solicitação agendada** com janela de arrependimento, e cria
no painel do dono a fila de solicitações para o contato de retenção.

**Regras decididas com o dono (14/09/2026):**

| | Com exportação | Sem exportação |
|---|---|---|
| Prazo | **10 dias úteis** (pula fins de semana **e feriados nacionais**) | **48 horas** |
| O que acontece na data | exporta → e-mail com link → **confirma entrega** → exclui | exclui |
| Durante a espera | app em **somente-leitura** + banner + botão de cancelar | idem |

A exclusão com exportação **só acontece depois que o Resend confirmar a entrega do e-mail**. Sem
confirmação, nada é apagado.

Execução **híbrida**: `pg_cron` de hora em hora executa o que venceu; o dono pode cancelar,
antecipar ou marcar exportação enviada pelo painel. O cliente pode cancelar sozinho pelo app.

**Escopo: 3 repositórios.** `c:\develop\MOBILE\sir-barbecue` (app + banco + Edge Functions),
`c:\develop\WEB\sir-barbecue-web` (PWA), `c:\develop\WEB\sir-barbecue-admin` (painel do dono).

---

## Decisões de arquitetura

**D1 — `tenant_has_access()` é a alavanca do somente-leitura.**
`docs/banco-multi-cliente/MIGRATION_11_tenant_has_access.sql:56` já é consultada por **todas** as
policies de escrita (sales, sale_items, tabs, tab_items, categories, products, stock_items,
stock_entries, suppliers, product_suppliers, product_day_visibility). Acrescentar
`and not exists (solicitação pendente para este tenant)` bloqueia a escrita no app inteiro, nos
três clientes, em um só lugar. Nada de policy nova.

**D2 — `get_access_status` continua com `allowed = true` no somente-leitura.**
Asymmetria deliberada com a `tenant_has_access` (a MIGRATION_11 manda manter as duas iguais — esta
é a exceção, e vai comentada nos dois arquivos). Se `allowed` virasse `false`, o app cairia no
`AccessBlocked` de tela cheia e o cliente perderia o botão de cancelar — matando a retenção. A RPC
ganha `readOnly: boolean` e um bloco `deletion`. Como `src/services/access.ts` já cacheia o veredito
em `secureStorage`, o somente-leitura **sobrevive ao modo avião** de graça.

**D3 — a solicitação sobrevive à exclusão, o dado pessoal não.**
`tenant_id` com `on delete set null` + snapshot de `tenant_name`. Ao executar a exclusão, os campos
de contato (nome/telefone/e-mail) são **apagados** e `contact_erased_at` é carimbado. O painel
mantém o histórico ("atendida") sem guardar dado pessoal de quem pediu para sumir — mesma doutrina
da MIGRATION_21 ("não ancorar trilha de auditoria em tabela que a lei manda apagar").

**D4 — as duas datas vêm do servidor.** App offline-first com relógio manipulável e 3 clientes que
não podem divergir. A tela pede `deletion_request_preview()` e só escolhe qual data exibir.

**D5 — a `delete-account` deixa de excluir e passa a agendar.** Mantém o mesmo nome, CORS e
reautenticação por senha/e-mail (achado A06-03 da auditoria). Para **manager/employee** o
comportamento continua imediato (apaga só o vínculo e o usuário) — exportação, janela e contato de
retenção só fazem sentido para o titular.

**D6 — quem executa de fato é uma Edge Function nova**, `process-deletion-requests`, chamada pelo
`pg_cron`→`pg_net` com token (padrão idêntico ao `send-subscription-reminder`) e também pelo painel.
Só ela tem `service_role` para apagar de `auth.users`.

**D7 — ~~o builder do zip vira módulo compartilhado~~. REVERTIDA NA IMPLEMENTAÇÃO.**
O plano previa `supabase/functions/_shared/companyExport.ts` importado pelas duas funções. Ao
implementar, o `supabase/functions/README.md` deixou claro que as funções são self-contained **de
propósito**, para poderem ser coladas no editor do dashboard — e o próprio README cita o erro que o
padrão `_shared` provoca lá (`Module not found .../_shared/utils.ts`). O Supabase CLI nem está
instalado na máquina do dono. Então a montagem do zip foi **duplicada** em
`process-deletion-requests`, com um aviso no topo dos dois arquivos: *mudou numa, mude na outra*.
Mesma convenção que a MIGRATION_11 já usa para `tenant_has_access`/`get_access_status`.

**D8 — o sync tem que drenar antes do somente-leitura fechar a porta, e a trava é dupla.**
A `delete-account` roda no **servidor** e não alcança o SQLite do aparelho: quem consegue subir a
venda registrada offline é só o app. Então:
- **trava 1 (app)** — antes de chamar a `delete-account`, o app roda o push do `syncEngine` e
  **se recusa a agendar** enquanto sobrar linha pendente, com mensagem explícita;
- **trava 2 (banco)** — um segundo aparelho da equipe pode ter venda offline que ninguém empurrou.
  Enquanto a solicitação está pendente, `INSERT` em `sales`/`sale_items`/`tabs`/`tab_items`
  continua permitido (é o dreno do sync), e todo o resto — update, delete, catálogo, estoque,
  fornecedor — fica bloqueado. Policies permissivas se somam com OR, que é exatamente o mecanismo
  que a MIGRATION_11 já usa para manter o SELECT vivo enquanto o write nega. A UI não oferece
  venda nova nesse estado; a policy existe só para o sync terminar de subir o que já existia.

**D9 — confirmação de entrega é trava de execução, não registro.**
O envio pelo Resend devolve um `id`; o evento `email.delivered` chega por webhook. A exclusão da
empresa **só roda depois** de `export_email_status = 'delivered'`. Não confirmou em 5 dias (ou
voltou `bounced`) → a solicitação vai para `failed`, aparece no painel para contato manual e
**nada é apagado**. Abrir o e-mail (`email.opened`) é registrado quando vier, mas não serve de
trava: bloqueio de imagem torna esse evento pouco confiável.

---

## Fase 1 — Banco (`docs/banco-multi-cliente/MIGRATION_24_account_deletion_requests.sql`)

Seguir o cabeçalho padrão das migrações (PROBLEMA / DECISÕES / O QUE MUDA + rodapé de VERIFICAÇÃO
com queries comentadas), `begin; … commit;`, idempotente. Próximo número livre: **24**.

**Tabela `public.account_deletion_requests`**
```
id uuid pk default gen_random_uuid()
tenant_id uuid references tenants(id) on delete set null   -- D3
tenant_name varchar(200) not null                          -- snapshot
requested_by uuid not null                                 -- sem FK p/ auth.users (MIGRATION_20/21)
requested_at timestamptz not null default now()
export_requested boolean not null
scheduled_for timestamptz not null
status text not null default 'pending'
       check (status in ('pending','canceled','completed','failed'))
export_status text not null default 'not_requested'
       check (export_status in ('not_requested','pending','sent','delivered','failed'))
export_sent_at timestamptz
export_email_id text                                       -- id devolvido pelo Resend (D9)
export_email_status text                                   -- queued|sent|delivered|bounced|complained
export_delivered_at timestamptz, export_opened_at timestamptz
contact_name text, contact_phone text, contact_email text  -- apagados na execução
contact_erased_at timestamptz
canceled_at timestamptz, canceled_by uuid, canceled_by_admin boolean not null default false
completed_at timestamptz, last_error text
created_at/updated_at timestamptz default now()
```
- `create unique index if not exists uq_deletion_request_pending on account_deletion_requests(tenant_id) where status = 'pending'` — uma pendente por empresa.
- Índice `(status, scheduled_for)` para a varredura do cron.
- **RLS**: `deletion_request_member_read` (select via `user_tenant_ids()` — o funcionário precisa
  saber por que o app travou) + `deletion_request_admin_all` (`is_platform_admin()`). **Nenhuma
  policy de insert/update/delete**: escrita só pelas RPCs `security definer` e pelo `service_role`.

**Dias úteis com feriados nacionais** — duas peças:

- **`public.holidays(day date primary key, name text not null, scope text default 'nacional')`** —
  tabela, não lista fixa no código: o dono pode acrescentar feriado municipal ou ponto facultativo
  sem migração nova. RLS: leitura para `authenticated`, escrita só `is_platform_admin()`.
- **`public.seed_br_holidays(p_from_year int, p_to_year int)`** — semeia com `on conflict do nothing`.
  Fixos: 01/01, 21/04, 01/05, 07/09, 12/10, 02/11, **20/11** (Consciência Negra, nacional desde a
  Lei 14.759/2023), 15/11, 25/12. Móveis, todas derivadas da Páscoa (algoritmo de Meeus/Butcher,
  `public.easter_sunday(p_year int) returns date`): **segunda de Carnaval** (Páscoa − 48),
  **terça de Carnaval** (− 47), **Sexta-feira Santa** (− 2) e **Corpus Christi** (+ 60).
  Carnaval e Corpus Christi são ponto facultativo e não feriado nacional, mas entram por decisão do
  dono (14/09/2026) — na prática o comércio pequeno não abre, e o prazo prometido tem que refletir
  isso. `scope = 'facultativo'` nessas quatro para ficarem distinguíveis depois. Semear
  **2026–2036** na migração: 13 datas por ano.
- **`public.add_business_days(p_from timestamptz, p_days int) returns timestamptz`** — conta em
  `America/Sao_Paulo`, pula sábado, domingo e qualquer data presente em `holidays`, devolve o
  resultado às **09:00 -03** (hora em que a exportação sai e a exclusão roda).
  ⚠️ **Alarme de calendário**: a semeadura acaba em 2036. `run_due_account_deletions()` deve emitir
  `raise warning` quando o último feriado semeado estiver a menos de 1 ano — senão, em 2036, o prazo
  volta a ignorar feriados em silêncio.

**RPCs do cliente** (todas `security definer set search_path = public`, `grant execute to authenticated`):
- `deletion_request_preview() returns jsonb` → `{ dateNoExport, dateWithExport }` (D4).
- `cancel_account_deletion(p_tenant_id uuid) returns jsonb` → só `is_tenant_owner(p_tenant_id)`;
  marca `status='canceled'`, `canceled_by = auth.uid()`. Devolve `{ ok: true }`.
- (o **insert** não é RPC — vem da `delete-account`, que é quem validou a senha. D5.)

**`tenant_has_access(uuid)`** — recriar com a cláusula nova (D1), mantendo todo o resto:
```sql
and not exists (select 1 from public.account_deletion_requests r
                 where r.tenant_id = p_tenant_id and r.status = 'pending')
```

**Policies de dreno do sync (D8)** — `public.tenant_sync_drain(p_tenant_id uuid) returns boolean`
(`stable security definer`) = existe solicitação pendente. Quatro policies **só de INSERT**,
somando por OR com as `_write` existentes:
```sql
create policy sales_drain_insert on public.sales for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_sync_drain(tenant_id));
```
idem `sale_items`, `tabs`, `tab_items` (estas três isolando pelo pai, como já fazem hoje).
⚠️ **Verificar antes**: se a venda entra por `create_sale` (`MIGRATION_12_create_sale_guards.sql`)
como `security definer`, ela **não passa pela RLS** — nesse caso o dreno já funciona de graça e
essas policies viram redundância defensiva; mas a função precisa ganhar a mesma checagem para não
virar o buraco que deixa vender com a exclusão agendada.

**`get_access_status(p_tenant_id)`** — recriar (a versão vigente é a de
`docs/assinatura-app/MIGRATION_03_activation_and_reminders.sql:55`; a nova versão vai na
MIGRATION_24 com um comentário apontando isso) acrescentando ao `jsonb_build_object`:
`'readOnly'` e `'deletion'` (`{ requestId, requestedAt, scheduledFor, exportRequested, exportStatus, contactEmail, canCancel }`,
`canCancel` = `is_tenant_owner`). `allowed` **não muda** (D2).

**`delete_tenant_cascade(uuid)`** — quinta versão (a vigente é a da MIGRATION_22:107). Antes do
`delete from public.tenants`, acrescentar o passo de preservação/anonimização da solicitação:
`update account_deletion_requests set status='completed', completed_at=now(), contact_name=null, contact_phone=null, contact_email=null, contact_erased_at=now() where tenant_id = p_tenant_id`.
Com `on delete set null` não há problema de ordem de cascade — a armadilha das MIGRATIONs 18/19/21/22 não se repete aqui.

**RPCs do painel** (mesmo padrão: `if not public.is_platform_admin() then raise exception 'forbidden: …'`):
- `admin_list_deletion_requests(p_status text default 'pending', p_export boolean default null, p_search text default null, p_limit int default 100, p_offset int default 0) returns jsonb` — array camelCase.
- `admin_deletion_requests_pending_count() returns int` (badge do menu + faixa do dashboard).
- `admin_cancel_deletion_request(p_id uuid)` — `canceled_by_admin = true`.
- `admin_mark_export_sent(p_id uuid)` — marcação **manual** (o dono mandou o arquivo por fora, ou o
  webhook não chegou): `export_status='delivered'`, `export_sent_at`/`export_delivered_at = now()`,
  registrando que foi manual. É a válvula de escape da trava D9.
- `admin_list_tenants_overview()` e `admin_tenant_detail(uuid)` — recriar acrescentando o bloco
  `deletionRequest` (null quando não houver). São as duas RPCs que alimentam Clientes/Detalhe.

**Função do cron** — `public.run_due_account_deletions()`, espelhando
`send_subscription_due_reminders` (`MIGRATION_03_activation_and_reminders.sql:128`): lê o token do
**Vault** (`deletion_worker_token`), sai em silêncio se nulo, e chama a Edge Function via
`net.http_post`. `revoke execute from public, authenticated, anon`. Wrapper de teste
`admin_run_due_account_deletions_now()` gated por `is_platform_admin()`.

---

## Fase 2 — Edge Functions e infra de produção

**`supabase/functions/_shared/companyExport.ts` (novo)** — extrair de
`export-company-data/index.ts:163-352` a montagem do zip (`csvCell`, `toCsv`, `nameOf`, as 13
planilhas e a cópia dos relatórios) para `buildCompanyExportZip(admin, tenantId, range?)`.
`export-company-data/index.ts` passa a importá-la, sem mudança de comportamento.

**`delete-account/index.ts` — reescrita do miolo (D5).** Mantém CORS, `jsonFor`, reautenticação
(`:152-176`) e a descoberta de `ownedIds` por `owner_user_id`. Depois disso:
- corpo passa a aceitar `{ password?, confirmText?, exportRequested: boolean, contactName: string, contactPhone: string, localPending: number }`;
- **`localPending > 0` → recusa com 409** e a mensagem `Há vendas ainda não enviadas neste aparelho. Conecte-se à internet e tente de novo.` (trava 1 da D8 — o push é do app, ver Fase 3);
- **é dono de empresa** → valida os contatos, chama `deletion_request_preview()`, insere a linha em
  `account_deletion_requests` (uma por empresa que possui), devolve
  `{ scheduled: true, scheduledFor, exportRequested }`. **Não apaga nada, não desloga.**
  Se já existir pendente, devolve a existente (idempotente).
- **não é dono** → caminho de hoje, inalterado: `removed_at` no vínculo + `deleteUser`.

**`supabase/functions/process-deletion-requests/index.ts` (nova)** — dois modos de entrada:
`?token=` na querystring (cron, deploy com `--no-verify-jwt`) ou JWT de `is_platform_admin` com
`{ requestId }` no corpo (botão "Excluir agora" do painel). Para cada solicitação devida
(`status='pending' and scheduled_for <= now()`), **nesta ordem**, que é a lição gravada em
`delete-account/index.ts:226` (*operação não-transacional vem por último* — mas o cliente precisa
receber os dados **antes** de eles serem destruídos):
**Etapa A — enviar** (solicitação com `export_requested` e `export_status in ('not_requested','pending')`):
`buildCompanyExportZip` → upload em `exports/deletions/<requestId>.zip` (fora da pasta do tenant,
para não ser varrido no passo 5) → signed URL de **30 dias** → e-mail pelo Resend (mesmo `fetch` de
`send-subscription-reminder/index.ts:96`, com `escapeHtml`) → grava `export_email_id`,
`export_status='sent'`. **Falhou o envio?** `last_error`, `export_status='failed'`, segue `pending`
para a próxima rodada — nunca apagar sem entregar.

**Etapa B — excluir**, só quando `export_status='delivered'` (D9) ou `export_requested = false`.
Enquanto o `delivered` não chega, a solicitação fica visível no painel como *aguardando confirmação
de entrega*. Passados **5 dias** do envio sem confirmação, ou vindo `bounced`/`complained`:
`status='failed'` + `last_error`, some da fila automática e entra na lista de contato manual do dono.
Os passos da exclusão, nesta ordem:
1. (etapa A já concluída e confirmada);
2. `rpc('delete_tenant_cascade')` por empresa (já marca a solicitação como `completed` e anonimiza — D3);
3. `removed_at` nos vínculos do usuário em outras empresas;
4. `auth.admin.deleteUser(requested_by)`;
5. limpeza de Storage (`reports/<tenantId>/`, `exports/<tenantId>/`) em `try/catch` que não derruba.
- Uma solicitação com erro **não pode derrubar as outras**: `try/catch` por linha (mesma lição do
  `project-sync-oversell`).
- Cleanup: apagar `exports/deletions/*` com mais de 30 dias no início de cada rodada.

**`supabase/functions/resend-webhook/index.ts` (nova)** — recebe os eventos do Resend
(`email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.opened`) e atualiza a
linha pelo `export_email_id`. Deploy com `--no-verify-jwt` (quem chama é o Resend, sem JWT), e a
autenticação é a **assinatura Svix** do payload (`svix-id`/`svix-timestamp`/`svix-signature` +
`RESEND_WEBHOOK_SECRET`), validada **antes** de ler o corpo — sem isso qualquer um marca um e-mail
como entregue e destrava a exclusão de uma empresa. Rejeitar timestamp com mais de 5 minutos
(anti-replay). É o único endpoint novo exposto publicamente; vale passada do `/security-review`.

**Infra em produção** — `pg_cron` já habilitado e Resend já implantado e funcionando (confirmado
pelo dono em 14/09/2026; a `AUDITORIA_SEGURANCA_OWASP_2025.md:1085` está desatualizada nesse ponto
e deve ser corrigida). Falta só o que é específico desta entrega:
- `select vault.create_secret('<token>', 'deletion_worker_token')`;
- `cron.schedule('process-deletion-requests', '0 * * * *', $$select public.run_due_account_deletions();$$)`
  — **de hora em hora**, não diário: a promessa de 48 h é em horas;
- secrets da Edge Function: `DELETION_WORKER_TOKEN` e `RESEND_WEBHOOK_SECRET`
  (`RESEND_API_KEY`/`EMAIL_FROM` já existem);
- cadastrar o endpoint do webhook no painel do Resend, assinando os 5 eventos acima.

---

## Fase 3 — App mobile (`c:\develop\MOBILE\sir-barbecue`)

Desenho, wireframes e microcópia literal: seguir o documento do agente de UI (resumido abaixo).

- **`src/ui/OptionRow.tsx` (novo)** — não existe checkbox/radio no repo. `Pressable`,
  `minHeight 56`, borda 2 px `gold` quando selecionado, círculo de 24 px,
  `accessibilityRole="radio"` + `accessibilityState={{ checked }}`, `accessibilityLabel` com a data
  **por extenso** (o TalkBack lê "28/09/2026" como dígitos soltos).
- **`src/ui/Button.tsx`** — novo `variant="danger"` (`colors.red` + texto branco, 9,2:1) e prop
  `disabledReason?: string` (aparência de desabilitado, mas pressionável: o toque mostra o motivo
  em toast em vez de agir; `accessibilityHint`).
- **`app/(app)/mais/perfil.tsx`** — o `dangerCard` vira o formulário da solicitação: parágrafo
  novo ("A conta NÃO é excluída agora…"), atalho `Baixar meus dados agora` → `/mais/exportar-dados`,
  **dois `OptionRow`** (pré-selecionado o *com* exportação — o default nunca é a opção que destrói
  mais rápido), campos **Nome do responsável** e **Telefone (WhatsApp)** (sempre visíveis,
  telefone pré-preenchido de `tenants.phone` via `fetchTenant`), campo de prova existente, resumo
  com a data e botão `Solicitar exclusão ({data})` — a data no rótulo do botão é a proteção
  principal. `Alert.alert` final. **Sem `signOut()` no sucesso.** Subir `dangerText` de 13 px para
  `fontSizes.body` (o repo exige corpo ≥ 16). Manter `returnKeyType="done"` + `blurOnSubmit`.
  Quando já houver solicitação, a tela mostra um `pendingCard` **amarelo** (datas, contato
  informado, botão `Cancelar solicitação`) e o botão "Excluir conta" some.
- **`src/services/access.ts`** — `AccessVerdict` ganha `readOnly: boolean` e
  `deletion: DeletionInfo | null`; `normalize()` e o cache carregam os dois (é isso que fecha o
  buraco do modo avião).
- **`src/lib/permissions.ts`** — `usePermissions()` passa a receber o `readOnly` do store de acesso
  e zera todos os `canWrite*`. É o gate que a maioria das telas já consulta.
- **`src/services/functions.ts`** — `deleteAccount` ganha os campos novos e devolve
  `{ scheduledFor, exportRequested }`; nova `cancelAccountDeletion(tenantId)`.
- **Push do sync antes de agendar (trava 1 da D8)** — no `onPress` do botão, antes de chamar
  `deleteAccount`: rodar o push do `src/data/sync/syncEngine.ts`, contar as linhas ainda pendentes
  no SQLite e **abortar** se sobrar alguma, com o toast
  `Há vendas ainda não enviadas. Conecte-se à internet e tente de novo.` O `localPending` vai no
  corpo da chamada como segunda checagem no servidor. É o passo que impede a venda registrada
  offline de ser destruída antes de subir.
- **`app/(app)/_layout.tsx`** — `ReadOnlyBanner` fixo (fundo `colors.yellow`, texto `colors.bg`),
  **abaixo** do `OfflineBanner`, com `paddingTop` do inset só quando o offline não estiver visível.
  Texto diferente para owner e para manager/employee.
- **Home** — card amarelo como primeiro bloco do `ScrollView`, escondendo o nudge de boas-vindas
  enquanto houver solicitação: título `Sua conta será excluída em {data}`, linha do e-mail/data da
  exportação e `Button variant="gold"` **Cancelar solicitação e voltar a usar** (o botão bom é
  dourado; o `Alert` de confirmação dele **não** usa `style: 'destructive'`).
- **Telas de ação** — `disabledReason` nos botões de venda, fechar venda, comandas, produtos
  (+Novo/Salvar), estoque, empresa e fornecedor; inputs com `editable={false}` (padrão que
  `empresa.tsx:224` já usa). **Allowlist** que continua funcionando: sair, cancelar solicitação,
  Exportar dados, Relatórios, sync de leitura.
- **`src/ui/AccessBlocked.tsx`** — se o trial vencer durante a janela, o `AccessBlocked` de tela
  cheia engole o botão de cancelar e a retenção morre em silêncio. Acrescentar nota amarela +
  `Button variant="outline"` **Cancelar solicitação de exclusão**.
- **`app/(app)/mais/exportar-dados.tsx`** — mantida (é o caminho para pegar os dados **agora**);
  ajuste de texto separando "baixar agora" de "receber por e-mail ao excluir", e aviso amarelo no
  topo quando houver solicitação pendente.

---

## Fase 4 — PWA web (`c:\develop\WEB\sir-barbecue-web`)

Mesma hierarquia, mesma microcópia, mesmas cores. Diferenças:
- `<input type="radio">` nativo dentro de `<label>` (semântica e setas de graça) — **não** criar componente;
- `window.confirm()` no lugar do `Alert.alert` (é o que `Conta.tsx` já faz);
- `variant="danger"` **já existe** no `Button` do web;
- banner somente-leitura em `src/app/AppShell.tsx`, entre `OfflineBanner` e `<header>`, `role="status"`;
- inputs travados com `readOnly` + `aria-readonly` (não `disabled`, que o leitor de tela pula);
- **remover o `signOut()`** do sucesso da exclusão em `src/screens/conta/Conta.tsx`;
- sem banco local: offline a tela só informa `Precisa de internet para solicitar a exclusão.`
- gate: `npm run build` (`tsc` + `vitest`) — a matriz travada em `permissions.test.ts` vai precisar
  da linha nova de `readOnly`.

---

## Fase 5 — Painel do dono (`c:\develop\WEB\sir-barbecue-admin`)

- **`src/types.ts`** — `DeletionRequest`, `DeletionRequestStatus`, `ExportStatus`; `TenantOverview`
  e `TenantDetail` ganham `deletionRequest: DeletionRequest | null`.
- **`src/hooks/useAdmin.ts`** — `useDeletionRequests(filters)`, `usePendingDeletionCount()`,
  `useCancelDeletionRequest()`, `useMarkExportSent()`, `useExecuteDeletionNow()` (esta invoca a
  Edge Function). Padrão do arquivo: `if (USE_MOCK) return …` como primeira linha, `if (error) throw error`,
  `onSuccess` só invalidando as keys.
- **`src/lib/mock.ts`** — constantes + funções mutadoras, como `mockExtendTrial`.
- **`src/pages/Solicitacoes.tsx` (nova)** + rota `/solicitacoes` em `App.tsx` + item no array `nav`
  de `Layout.tsx` **na posição 2, logo depois de Clientes**, ícone `UserMinus`, com **badge de
  contagem** amarelo quando houver pendentes (único item do menu com badge — é a raridade que faz
  funcionar). **Uma tela só**, cobrindo com e sem exportação (separar em duas esconderia justamente
  os casos de 48 h, que são os mais urgentes).
  - Filtros: busca (empresa/e-mail/responsável) + status (**default `Pendentes`**) + exportação.
  - Padrão dual obrigatório: `<table>` no desktop (`hidden lg:block`), `DataCard`/`DataRow` no mobile (`lg:hidden`).
  - Colunas: Empresa · Solicitado em · Excluir em (com `em 14 dias`; `text-danger` quando ≤ 1 dia) ·
    Exportação · Contato (nome + telefone como link `wa.me` + e-mail) · Status · Ações.
  - A coluna **Exportação** mostra o estágio da entrega (D9): `Não` · `Pendente` · `Enviado —
    aguardando confirmação` · `Entregue em {data}` · `Falha na entrega` (badge `danger`). É por essa
    coluna que o dono descobre que uma exclusão está travada esperando o webhook.
  - Ações na lista: `Cancelar` (outline) e `Marcar entrega manualmente` (ghost, só quando o envio
    falhou ou está sem confirmação há mais de 5 dias) + link `Abrir cliente →`.
    **"Excluir agora" NÃO aparece na lista** — botão irreversível em tabela densa é clique errado
    garantido.
  - `SolicitacaoBadge` local (o `StatusBadge` global só aceita status de assinatura), seguindo o
    precedente do `SeverityBadge` de `Erros.tsx`.
- **`src/pages/Dashboard.tsx`** — faixa de largura total **acima** do grid de KPIs (um 5º KPI criaria
  órfão no grid de 4 e igualaria um evento raro ao MRR). Com pendências: `Card` com
  `border-yellow`, contagem + até 3 linhas `{Empresa} · excluir em {data} · {com/sem exportação}`
  ordenadas por prazo + `Ver solicitações →`. **Com zero: uma linha discreta no mesmo slot**
  (`Nenhuma solicitação de exclusão pendente.`) — o slot existe sempre, para a página não saltar.
- **`src/pages/ClienteDetalhe.tsx`** — card `border-yellow` de largura total logo abaixo do
  `PageHeader` e **acima** do grid Assinatura/Dispositivos (ele muda o sentido de tudo que vem
  depois). Três ações, nesta ordem: `Cancelar solicitação (manter cliente)` (**gold**, é o objetivo
  da janela) · `Marcar entrega manualmente` (outline, com a nota *"não antecipa a exclusão"*) ·
  `Excluir agora (não espera o prazo)` (**danger**, separado por `border-t`, alinhado à direita).
  Duas travas no destrutivo: `disabled` enquanto exportação = Sim e a entrega **não estiver
  confirmada** (impede o erro mais caro possível: apagar os dados de quem pediu cópia deles, sem
  que a cópia tenha chegado) e `window.prompt` exigindo **digitar o nome da empresa**.
- **`src/pages/Clientes.tsx`** — segunda linha `Exclusão em {data}` em `text-xs text-yellow` sob o
  nome (desktop) e um `DataRow` (mobile).
- Gate: `npm run build` (`tsc` + `vite build`, com `noUnusedLocals` e `verbatimModuleSyntax`).

---

## Correções feitas durante a implementação (não estavam no plano)

Três coisas que só apareceram com o código na mão, e que valem registro porque
cada uma era um defeito real:

1. **Zerar `canWriteCatalog` no somente-leitura expulsava o usuário da tela.**
   `produtos/form.tsx` faz `if (!canWriteCatalog) return <Redirect href="/venda" />`.
   Com a flag zerada, tocar num produto jogava a pessoa para fora sem explicação —
   o oposto do contrato "vê tudo, não age". Agora o **papel** governa navegação e
   visibilidade; o **readOnly** governa só a ação.
2. **O `syncEngine` não pode consultar o `readOnly` pelos predicados puros.** Ele
   chama `canWriteCatalog(role)` direto para decidir o que empurrar; aplicar o
   somente-leitura ali mataria o dreno das vendas offline — justamente o que a D8
   existe para proteger. O `readOnly` entra só no hook `usePermissions()`, e o
   sync ganhou uma checagem própria para não tentar pushes que a RLS negaria (o
   que geraria o toast falso de "sem permissão").
3. **No PWA, `disabledReason` num botão `type="submit"` não bastava.** Vários
   botões de escrita vivem dentro de `<form>`; trocar o `onClick` não impede o
   submit. O botão inerte passa a ser `type="button"`.

E uma correção de LGPD que o teste do banco expôs: a primeira versão do
`delete_tenant_cascade` anonimizava só as solicitações `pending`/`failed`, e uma
solicitação **cancelada** continuava guardando nome, telefone e e-mail depois de a
empresa ser apagada. Agora o contato some de **todas** as solicitações daquela
empresa — com a empresa fora do ar, não há mais para quem ligar.

## Fase 6 — Textos legais e ajuda (bloqueador de release)

`src/content/politicaDePrivacidade.ts` e `src/content/termosDeUso.ts` do repo **admin** (servidos
aos três clientes) afirmam que a exclusão é imediata e irreversível — passa a ser mentira. Reescrever
com os prazos (48 h / 10 dias úteis), a janela de cancelamento e o envio por e-mail. Acrescentar um
tópico em `src/content/help/topics.ts`: *"O que acontece quando eu excluo minha conta"*.

---

## Verificação (ponta a ponta, obrigatória antes de considerar pronto)

**Banco** (SQL Editor, empresa de teste com produto, vendas, estoque e relatório gerado):
1. `select public.deletion_request_preview();` → confere 48 h e a data de 10 dias úteis.
   **Testar contra um feriado**: `select public.add_business_days('2026-12-18'::timestamptz, 10);`
   deve pular 25/12 e 01/01 e cair em 05/01/2027. Conferir as móveis de 2027 (Páscoa em 28/03):
   Carnaval 08 e 09/02, Sexta-feira Santa 26/03, Corpus Christi 27/05 — e que `holidays` tem
   **13 linhas por ano**, de 2026 a 2036.
2. Inserir solicitação pendente → `select public.tenant_has_access('<tenant>')` deve virar **false**
   e `get_access_status` deve devolver `allowed: true` + `readOnly: true`.
3. **Teste de bypass por API** (mesmo método da MIGRATION_11/22 — *não* pelo SQL Editor, que roda
   como `postgres` e pula RLS): `curl` com token de owner real chamando `create_sale` → deve falhar;
   `select` de produtos → deve continuar funcionando.
4. `cancel_account_deletion` → escrita volta a funcionar.

**App (mobile e PWA, os dois):** solicitar com exportação → conferir a data na tela, no botão e no
`Alert`; o app entra em somente-leitura (tentar vender, cadastrar produto e dar entrada de estoque);
banner e card da Home aparecem; **cancelar** e confirmar que tudo volta ao normal. Repetir sem
exportação. Testar em **modo avião** que o somente-leitura persiste. Testar como manager/employee
(vê banner, não vê botão de cancelar). Testar exclusão de conta de funcionário (deve continuar imediata).

**Dreno do sync (D8):** com uma solicitação pendente, conferir que `INSERT` em `sales`/`sale_items`
pela API **passa** e que `UPDATE` de produto, `INSERT` de estoque e `DELETE` de venda **falham**. No
aparelho: registrar venda offline, ativar o modo avião, tentar agendar → deve ser recusado; voltar
online, deixar o sync subir, agendar de novo → deve passar.

**Execução (duas etapas, D9):** com uma solicitação vencida,
`select public.admin_run_due_account_deletions_now();` →
(A) e-mail chega com link que baixa o zip íntegro e a linha fica `export_status='sent'` — **e a
empresa continua intacta**; (B) o webhook do Resend marca `delivered` e a rodada seguinte apaga:
`tenants`/`sales`/`products` zerados, usuário fora de `auth.users`, pastas `reports/<tenant>` e
`exports/<tenant>` limpas, e a linha da solicitação sobrevive com `status='completed'` e contato
**nulo**. Três caminhos de falha a testar: (1) `RESEND_API_KEY` inválida → nada apagado,
`export_status='failed'`; (2) envio para um endereço que dá bounce → nada apagado, entra na lista de
contato manual; (3) chamar o webhook com assinatura Svix inválida → **401**, e o `delivered` não é
gravado.

**Painel:** `npm run build` limpo; tela Solicitações com filtros e badge no menu; faixa do dashboard
nos dois estados (com e sem pendências); as três ações no detalhe do cliente, incluindo a trava do
`Excluir agora` enquanto a exportação não foi marcada.

---

## Riscos conhecidos

- **O cron falha em silêncio** (`run_due_account_deletions` só emite `raise notice`, e ninguém lê o
  retorno do `net.http_post` — problema já registrado em `AUDITORIA_SEGURANCA_OWASP_2025.md:1098`).
  Se ele parar, as datas prometidas não são cumpridas e nada acusa. Mitigação: a tela Solicitações
  mostra `Excluir em` em vermelho quando vence hoje/amanhã, e a fila parada fica visível no dashboard.
- **A exclusão pode ficar parada esperando o `delivered`.** É o comportamento desejado (D9), mas
  significa que uma solicitação pode passar do prazo prometido por causa do provedor de e-mail. O
  painel precisa deixar isso explícito — daí a coluna de estágio da entrega e o botão de marcação
  manual.
- **`resend-webhook` é endpoint público novo.** A validação da assinatura Svix é a única coisa entre
  um POST anônimo e "marcar como entregue" a exportação de uma empresa — o que destravaria a
  exclusão dela. Rodar `/security-review` nessa função antes do deploy.
- **A semeadura de feriados acaba em 2036** — sem o alarme de calendário previsto na Fase 1, o prazo
  volta a ignorar feriados sem avisar.
