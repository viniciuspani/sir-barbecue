> **Status (2026-08-30): código implementado E migrações já aplicadas no Supabase.**
> `MIGRATION_02_extend_trial.sql` e `MIGRATION_03_activation_and_reminders.sql` rodaram
> com sucesso (confirmado pelo usuário) — `admin_activate_tenant_subscription`, a
> carência de 48h em `get_access_status` e o card "Ativar assinatura" no painel já
> funcionam de verdade em produção.
>
> **Ainda pendente** (só isso falta para o e-mail de lembrete funcionar):
> 1. `select vault.create_secret('<token>', 'subscription_reminder_token');` no SQL Editor.
> 2. Criar conta na Resend, verificar domínio, e configurar os secrets da Edge Function
>    (`RESEND_API_KEY`, `EMAIL_FROM`, `SUBSCRIPTION_REMINDER_TOKEN` — mesmo token do passo 1)
>    + `supabase functions deploy send-subscription-reminder --no-verify-jwt`.
> 3. Habilitar `pg_cron` no Dashboard e descomentar o `cron.schedule(...)` no fim da
>    migração (ou disparar manualmente via `admin_run_subscription_due_reminders_now()`
>    enquanto o cron não estiver ligado).
>
> Sem esses 3 passos, `send_subscription_due_reminders()` já existe no banco mas aborta
> sem enviar nada (falta o token do Vault). Passo a passo completo da Resend na seção
> "Configuração da Resend" abaixo.

# Ativar assinatura (trial/past_due/canceled → active) + carência de 48h + lembrete por e-mail

## Contexto

Hoje, virar cliente pago é 100% manual: o dono precisa entrar no Supabase e fazer um
`UPDATE` direto em `subscriptions` (`status='active'`, `current_period_end=...`) — não há
RPC nem botão no painel (ver [[project-saas-licensing]]). O botão "Lançar pagamento" só
grava um registro histórico, não ativa nada.

Esta mudança fecha esse ciclo com 3 peças pedidas pelo usuário:
1. **Card "Ativar assinatura"** no painel: um clique define `status='active'` e o
   vencimento (`current_period_end`) = data de hoje + 1 mês (ex.: ativou 29/08/2026 →
   vence 29/09/2026). Visível quando a empresa está em `trial`, `past_due` ou `canceled`
   (decisão confirmada com o usuário — cobre tanto converter trial quanto reativar
   inadimplente/cancelado).
2. **Carência de 48h após o vencimento**: hoje `get_access_status()` bloqueia o app no
   instante exato do vencimento; passa a bloquear só 48h depois, sem mexer na data de
   vencimento exibida (o "presente" é invisível — o cliente/relatório sempre vê o
   vencimento real).
3. **E-mail automático 5 dias antes do vencimento** (contando a data real, sem as 48h de
   carência), para o e-mail cadastrado do dono da empresa, com uma mensagem simples e
   cordial avisando a data de vencimento. Provedor escolhido: **Resend**.

## Backend (Supabase) — repo mobile `c:\develop\MOBILE\sir-barbecue`

Novo arquivo `docs\assinatura-app\MIGRATION_03_activation_and_reminders.sql` (mesmo
padrão de `MIGRATION_01`/`MIGRATION_02`: `begin/commit`, idempotente, rodar manualmente no
SQL Editor) — e as mesmas definições entram também no schema vivo
`SUPABASE_SCHEMA_LICENSING.sql` (ver [[reference-schema-docs]]).

### 1. Nova coluna (idempotência do lembrete)
```sql
alter table public.subscriptions
  add column if not exists due_reminder_sent_for timestamptz;
```
Guarda **para qual `current_period_end`** o lembrete já foi disparado, pra não reenviar
todo dia dentro da janela de 5 dias, e pra reativar automaticamente quando o vencimento
mudar (nova ativação ou renovação futura).

### 2. RPC `admin_activate_tenant_subscription`
Segue o padrão de `admin_set_tenant_access`/`admin_extend_tenant_trial`
(`SUPABASE_SCHEMA_LICENSING.sql`, ~linha 322): guard `is_platform_admin()`, `p_`-prefixo,
`if not found`, grant final. **Sem filtro de status na cláusula WHERE** (ativa a partir de
qualquer estado — trial, past_due ou canceled):
```sql
create or replace function public.admin_activate_tenant_subscription(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  update public.subscriptions
     set status = 'active',
         current_period_end = now() + interval '1 month',
         updated_at = now()
   where tenant_id = p_tenant_id;
  if not found then
    raise exception 'assinatura não encontrada para a empresa %', p_tenant_id;
  end if;
end; $$;
grant execute on function public.admin_activate_tenant_subscription(uuid) to authenticated;
```
A trigger já existente `trg_subscriptions_contract_started_at` dispara sozinha nessa
mesma atualização e grava `contract_started_at = now()` (só na 1ª vez que o status vira
`active` — reativações depois não sobrescrevem, comportamento já correto e inalterado).

### 3. Carência de 48h em `get_access_status`
`create or replace` da função inteira (`SUPABASE_SCHEMA_LICENSING.sql`, ~linhas 213-281),
mudando **só** a condição de bloqueio do ramo `active` (linha ~261): de
`now() >= v_ends` para `now() >= v_ends + interval '48 hours'`. `v_ends` continua sendo
atribuído de `current_period_end` sem alteração — então `endsAt`/`daysRemaining` no
retorno da RPC continuam mostrando o vencimento real, só o bloqueio de fato atrasa 48h.
Ramo `trial` fica **intocado** (sem carência — o pedido do usuário é só sobre o
vencimento pago).

### 4. Lembrete automático por e-mail — `send_subscription_due_reminders()`
Roda via `pg_cron` (não é evento, é rotina periódica — não existe outro trigger cabível
aqui). `pg_cron` **nunca foi habilitado neste projeto** (é opcional, requer ligar a
extensão em Supabase Dashboard → Database → Extensions — mesmo caminho já documentado
pra limpeza de histórico de preço, nunca ativado). O agendamento fica **comentado** no
script, igual ao padrão já usado em `MIGRATION_03_price_history_cleanup_admin.sql` — você
precisa habilitar a extensão e descomentar/rodar o `cron.schedule(...)` uma vez.

```sql
create or replace function public.send_subscription_due_reminders()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_token text;
begin
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'subscription_reminder_token';
  if v_token is null then
    raise notice 'subscription_reminder_token não configurado no Vault — abortando envio.';
    return;
  end if;

  for r in
    select s.tenant_id, t.name as tenant_name, s.current_period_end, u.email
    from public.subscriptions s
    join public.tenants t on t.id = s.tenant_id
    join auth.users u on u.id = t.owner_user_id
    where s.status = 'active'
      and s.current_period_end is not null
      and u.email is not null
      and s.due_reminder_sent_for is distinct from s.current_period_end
      and (s.current_period_end at time zone 'America/Sao_Paulo')::date
          - (now() at time zone 'America/Sao_Paulo')::date between 0 and 5
  loop
    perform net.http_post(
      url     := 'https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/send-subscription-reminder?token=' || v_token,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := jsonb_build_object('email', r.email, 'tenantName', r.tenant_name, 'dueDate', r.current_period_end)
    );
    update public.subscriptions set due_reminder_sent_for = r.current_period_end
     where tenant_id = r.tenant_id;
  end loop;
end; $$;
revoke execute on function public.send_subscription_due_reminders() from public, authenticated, anon;

-- Pra testar sem esperar o cron (chamável pelo painel/SQL Editor pelo dono):
create or replace function public.admin_run_subscription_due_reminders_now()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  perform public.send_subscription_due_reminders();
end; $$;
grant execute on function public.admin_run_subscription_due_reminders_now() to authenticated;

-- AGENDAMENTO (pg_cron) — requer a extensão habilitada no Dashboard antes de descomentar:
-- select cron.schedule(
--   'send-subscription-due-reminders',
--   '0 12 * * *',  -- 12:00 UTC = 09:00 America/Sao_Paulo (sem horário de verão)
--   $$select public.send_subscription_due_reminders();$$
-- );
```
Janela `between 0 and 5` (em vez de `= 5` exato) é de propósito: cobre uma eventual falha
do cron num dia sem perder o aviso, e o `due_reminder_sent_for` garante que só sai um
e-mail por vencimento mesmo rodando todo dia dentro da janela.

**E-mail do cliente**: não existe coluna de e-mail em `tenants`/`subscriptions` — vem de
`auth.users.email` via `tenants.owner_user_id` (FK direta, já existe). Mesmo padrão de
join usado em `admin_list_error_logs` (`docs/banco-multi-cliente/MIGRATION_05_error_logs.sql`)
pra expor `userEmail`.

**Novo padrão neste projeto: Supabase Vault**, porque (diferente do push pra Expo, que não
precisa de segredo) uma chamada `pg_net` daqui *precisa* carregar um token que a Edge
Function vai validar, e esse token não pode ir em texto puro dentro do arquivo de
migração (iria pro Git). O Vault é o cofre nativo do Supabase (via `pgsodium`) — pós-migração,
**rodar uma única vez no SQL Editor** (fora do arquivo de migração, não versionado):
```sql
select vault.create_secret('<gere um token aleatório longo>', 'subscription_reminder_token');
```
O mesmo valor de token vai também como secret da Edge Function (`SUBSCRIPTION_REMINDER_TOKEN`,
passo 5).

## Edge Function — `supabase/functions/send-subscription-reminder/index.ts`

Self-contained, seguindo exatamente o template de `health-webhook/index.ts` (a função mais
parecida: chamada por algo que não é um usuário logado, protegida por token na query
string, fail-closed se o secret não estiver configurado, deploy `--no-verify-jwt`):

- Lê `SUBSCRIPTION_REMINDER_TOKEN` do ambiente; se vazio, responde 503 sem processar nada.
- Valida `?token=` da URL contra esse secret (404 se não bater, mesmo padrão anti-scan do
  `health-webhook`).
- Recebe `{ email, tenantName, dueDate }` no corpo (JSON).
- Formata `dueDate` em `dd/mm/aaaa` (`Intl.DateTimeFormat('pt-BR', { timeZone:
  'America/Sao_Paulo' })`).
- Monta um e-mail simples e cordial (assunto: "Sua assinatura Sir Barbecue vence em
  breve"; corpo avisando a data de vencimento e pedindo para regularizar o pagamento até
  lá; sem menção às 48h de carência — isso é bônus interno, não aparece pro cliente).
- Chama a API do Resend: `POST https://api.resend.com/emails` com header `Authorization:
  Bearer ${RESEND_API_KEY}` e corpo `{ from: EMAIL_FROM, to: [email], subject, html }`.
- Novos secrets a configurar (`supabase secrets set ...`, documentar em
  `supabase/functions/README.md`): `SUBSCRIPTION_REMINDER_TOKEN`, `RESEND_API_KEY`,
  `EMAIL_FROM` (endereço remetente, precisa de domínio verificado na Resend — passo fora
  deste plano, é conta/DNS do usuário).
- Deploy: `supabase functions deploy send-subscription-reminder --no-verify-jwt`.

## Configuração da Resend (passo a passo, fora do código)

Isso não é feito por mim — é conta/DNS do usuário, fica pronto pra quando a Edge Function
for chamada de verdade:

1. Criar conta em https://resend.com (tem plano gratuito, dá pra começar sem cartão).
2. **Domains** → **Add Domain** → informar o domínio que vai aparecer como remetente (ex.:
   `sirbarbecue.app` ou o domínio que a empresa já usa). A Resend mostra 2-3 registros DNS
   (geralmente `TXT`/`MX`/`CNAME` para SPF/DKIM) — cadastrar esses registros no provedor
   onde o domínio está hospedado (Registro.br, Cloudflare, GoDaddy, etc.).
3. Aguardar a verificação (a Resend confere sozinha, geralmente minutos a poucas horas
   dependendo da propagação DNS) — o domínio muda de "Pending" para "Verified" no painel
   deles.
4. **API Keys** → **Create API Key** → copiar a chave (só aparece uma vez).
5. Definir o endereço remetente: algo como `assinatura@sirbarbecue.app` (precisa ser um
   endereço do domínio verificado no passo 2-3; não precisa existir como caixa de e-mail
   de verdade, só precisa pertencer ao domínio).
6. Configurar os secrets da Edge Function (depois que ela existir no projeto):
   ```bash
   supabase secrets set RESEND_API_KEY="re_xxx..."
   supabase secrets set EMAIL_FROM="Sir Barbecue <assinatura@sirbarbecue.app>"
   supabase secrets set SUBSCRIPTION_REMINDER_TOKEN="<gere um token aleatório longo>"
   ```
   (o mesmo valor do `SUBSCRIPTION_REMINDER_TOKEN` também precisa ir pro Vault do Postgres
   — passo já descrito acima na seção do backend.)
7. Sem domínio próprio disponível agora: a Resend libera um remetente de teste
   (`onboarding@resend.dev`) que funciona sem verificar DNS, mas só entrega pro e-mail da
   própria conta Resend — serve pra testar a integração, não pra produção com clientes
   reais.

## Frontend (painel admin) — repo `c:\develop\WEB\sir-barbecue-admin`

1. **`src/hooks/useAdmin.ts`** — novo hook `useActivateTenantSubscription()`, mesmo padrão
   de `useExtendTenantTrial` (linhas ~93-108 após a edição anterior): chama
   `admin_activate_tenant_subscription`, invalida `keys.tenants` e `keys.tenant(tenantId)`.

2. **`src/lib/mock.ts`** — `mockActivateTenantSubscription(tenantId)`: acha o tenant em
   `mockTenants`, seta `status: 'active'`, `endsAt` = hoje + 1 mês (ISO), e
   `contractStartedAt` = hoje **só se ainda for `null`** (espelha a trigger real).

3. **`src/pages/ClienteDetalhe.tsx`** — novo Card "Ativar assinatura", em linha própria
   logo após o grid Assinatura/Dispositivos, **visível quando `data.status !== 'active'`**
   (cobre trial/past_due/canceled). Conteúdo: texto curto explicando o que vai acontecer
   + botão "Ativar assinatura" (`Button`), com `window.confirm` mostrando a data de
   vencimento calculada no cliente (`hoje + 1 mês`, só pra exibição — quem manda é o
   servidor) antes de chamar `activateSubscription.mutate({ tenantId })`. Mesmo texto de
   loading (`'Ativando…'`) das outras mutations.

Nenhuma mudança em `src/types.ts` (reaproveita `status`/`endsAt`/`contractStartedAt` já
existentes).

## Verificação

- `cd c:\develop\WEB\sir-barbecue-admin && npm run build` — typecheck.
- Modo mock (`VITE_USE_MOCK=true`): testar "Ativar assinatura" num tenant trial (`t2`) e
  num `past_due`/`canceled` (`t3`/`t4`), confirmar que o card aparece nos três e some só
  em `active` (`t1`), e que `Vencimento`/`Status` atualizam após a mutation.
- Backend real, após aplicar `MIGRATION_03...sql` e configurar o Vault + secrets da Edge
  Function: `select public.admin_activate_tenant_subscription('<tenant>');` e conferir
  `status='active'`, `current_period_end` = hoje+1 mês, `contract_started_at` preenchido.
- Testar a carência: `update subscriptions set current_period_end = now() - interval '1
  hour' where tenant_id='<tenant>'; select get_access_status('<tenant>');` → ainda
  `allowed=true` (dentro das 48h); depois `current_period_end = now() - interval '49
  hours'` → `allowed=false, reason=payment_overdue`.
- Testar o lembrete sem esperar o cron: configurar o Vault + `RESEND_API_KEY`/`EMAIL_FROM`
  + deploy da Edge Function, setar um `current_period_end` a ~3 dias de `now()` num tenant
  de teste com e-mail próprio, chamar `select
  public.admin_run_subscription_due_reminders_now();` logado como super-admin, e conferir
  o e-mail recebido + `due_reminder_sent_for` preenchido (rodar de novo não deve reenviar).
