-- =====================================================================
-- MIGRATION 24 — Exclusão de conta vira SOLICITAÇÃO AGENDADA (com janela de arrependimento)
-- Aplica SOBRE MIGRATION_11 (tenant_has_access), MIGRATION_12 (create_sale),
-- MIGRATION_21/22 (delete_tenant_cascade) e docs/assinatura-app/MIGRATION_03 e 04
-- (get_access_status, admin_list_tenants_overview, admin_tenant_detail). Idempotente.
-- Plano: docs/exportacao-dados/PLANO_EXCLUSAO_AGENDADA.md
--
-- PROBLEMA:
--   A exclusão de conta é IMEDIATA e irreversível: a Edge Function delete-account
--   valida a senha e roda delete_tenant_cascade na hora. Consequências:
--     • comercial — quando o cliente cancela a assinatura excluindo a conta, o dono
--       do SaaS não tem NENHUMA janela para ligar, entender o motivo e reverter.
--       O cliente vai embora sem contato;
--     • LGPD — não há caminho de portabilidade acoplado à saída. A exportação
--       existe (MIGRATION_22), mas é self-service e quem sai com raiva não passa
--       por ela.
--
-- O QUE MUDA:
--   A exclusão vira uma linha em account_deletion_requests com data marcada:
--     • COM exportação  -> 10 dias úteis; na data exporta, envia por e-mail,
--       CONFIRMA A ENTREGA e só então exclui;
--     • SEM exportação  -> 48 horas.
--   Até a data, a empresa fica em SOMENTE-LEITURA e a solicitação pode ser
--   cancelada pelo cliente (no app) ou pelo dono (no painel).
--
-- DECISÕES:
--   • O somente-leitura NÃO ganha policy nova: tenant_has_access() já é consultada
--     por TODAS as policies de escrita (MIGRATION_11), então uma cláusula a mais
--     nela desliga a escrita no app inteiro, nos três clientes, de uma vez.
--   • get_access_status continua devolvendo allowed = TRUE no somente-leitura.
--     É uma ASSIMETRIA DELIBERADA com tenant_has_access — a MIGRATION_11 manda
--     manter as duas com a mesma regra, e esta é a exceção. Se `allowed` virasse
--     false, o app cairia no AccessBlocked de tela cheia e o cliente perderia o
--     botão de cancelar, matando justamente a retenção que motivou a mudança.
--     Quem informa o estado novo é o par readOnly/deletion.
--   • DRENO DO SYNC: o app é offline-first e um segundo aparelho da equipe pode
--     ter venda registrada offline que ninguém empurrou. Se o somente-leitura
--     bloqueasse tudo, essa venda seria destruída sem nunca subir. Por isso o
--     INSERT em sales/sale_items/tabs/tab_items continua permitido enquanto a
--     solicitação está pendente (policies *_drain_insert) — todo o resto trava.
--     A UI não oferece venda nova nesse estado; a policy existe só para o sync
--     terminar de subir o que JÁ existia.
--   • A solicitação SOBREVIVE à exclusão (tenant_id on delete set null + snapshot
--     de tenant_name), mas o DADO PESSOAL não: nome/telefone/e-mail de contato são
--     apagados no momento da exclusão. Mesma doutrina da MIGRATION_21 — não
--     ancorar a trilha de auditoria numa tabela que a lei manda apagar, e não
--     guardar dado de quem pediu para sumir.
--   • Feriados são TABELA, não lista no código: o dono acrescenta feriado
--     municipal sem precisar de migração nova. Carnaval e Corpus Christi entram
--     (scope 'facultativo') por decisão do dono em 14/09/2026: na prática o
--     comércio pequeno não abre, e o prazo prometido tem que refletir isso.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) FERIADOS — tabela + cálculo da Páscoa + contagem de dias úteis
-- ---------------------------------------------------------------------
create table if not exists public.holidays (
  day   date primary key,
  name  text not null,
  scope text not null default 'nacional'
        check (scope in ('nacional', 'facultativo', 'municipal')),
  created_at timestamptz not null default now()
);

comment on table public.holidays is
  'Dias não-úteis usados por add_business_days. Semeada de 2026 a 2036 por seed_br_holidays; o dono pode acrescentar feriado municipal à mão.';

alter table public.holidays enable row level security;

drop policy if exists holidays_read on public.holidays;
create policy holidays_read on public.holidays for select to authenticated
  using (true);

drop policy if exists holidays_admin_all on public.holidays;
create policy holidays_admin_all on public.holidays for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Páscoa pelo algoritmo de Meeus/Butcher (calendário gregoriano). Todas as
-- móveis brasileiras derivam dela: Carnaval (-48/-47), Sexta-feira Santa (-2),
-- Corpus Christi (+60).
create or replace function public.easter_sunday(p_year int)
returns date
language plpgsql
immutable
as $$
declare
  a int; b int; c int; d int; e int; f int; g int; h int;
  i int; k int; l int; m int; v_month int; v_day int;
begin
  a := p_year % 19;
  b := p_year / 100;
  c := p_year % 100;
  d := b / 4;
  e := b % 4;
  f := (b + 8) / 25;
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;
  k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  v_month := (h + l - 7 * m + 114) / 31;
  v_day   := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(p_year, v_month, v_day);
end;
$$;

create or replace function public.seed_br_holidays(p_from_year int, p_to_year int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  y int;
  v_easter date;
begin
  for y in p_from_year..p_to_year loop
    v_easter := public.easter_sunday(y);

    insert into public.holidays (day, name, scope) values
      (make_date(y,  1,  1), 'Confraternização Universal', 'nacional'),
      (make_date(y,  4, 21), 'Tiradentes',                 'nacional'),
      (make_date(y,  5,  1), 'Dia do Trabalho',            'nacional'),
      (make_date(y,  9,  7), 'Independência',              'nacional'),
      (make_date(y, 10, 12), 'Nossa Senhora Aparecida',    'nacional'),
      (make_date(y, 11,  2), 'Finados',                    'nacional'),
      (make_date(y, 11, 15), 'Proclamação da República',   'nacional'),
      -- Nacional desde a Lei 14.759/2023.
      (make_date(y, 11, 20), 'Consciência Negra',          'nacional'),
      (make_date(y, 12, 25), 'Natal',                      'nacional'),
      -- Móveis. Sexta-feira Santa é feriado religioso nacional (Lei 9.093/95);
      -- Carnaval e Corpus Christi são ponto facultativo, incluídos por decisão
      -- do dono porque o comércio pequeno não abre.
      (v_easter - 48, 'Carnaval (segunda)', 'facultativo'),
      (v_easter - 47, 'Carnaval (terça)',   'facultativo'),
      (v_easter -  2, 'Sexta-feira Santa',  'nacional'),
      (v_easter + 60, 'Corpus Christi',     'facultativo')
    on conflict (day) do nothing;
  end loop;
end;
$$;

select public.seed_br_holidays(2026, 2036);

-- Conta dias úteis a partir de p_from, pulando sábado, domingo e holidays.
-- Devolve às 09:00 de São Paulo: é a hora em que a exportação sai e a exclusão roda.
create or replace function public.add_business_days(p_from timestamptz, p_days int)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_date date;
  v_left int := p_days;
begin
  v_date := (p_from at time zone 'America/Sao_Paulo')::date;
  while v_left > 0 loop
    v_date := v_date + 1;
    if extract(isodow from v_date) < 6
       and not exists (select 1 from public.holidays h where h.day = v_date) then
      v_left := v_left - 1;
    end if;
  end loop;
  return (v_date + time '09:00') at time zone 'America/Sao_Paulo';
end;
$$;

comment on function public.add_business_days(timestamptz, int) is
  'Soma dias ÚTEIS (pula fim de semana e public.holidays) e devolve às 09:00 America/Sao_Paulo.';

-- ---------------------------------------------------------------------
-- 2) A TABELA DE SOLICITAÇÕES
-- ---------------------------------------------------------------------
create table if not exists public.account_deletion_requests (
  id                 uuid primary key default gen_random_uuid(),
  -- SET NULL, não CASCADE: a solicitação tem de sobreviver à exclusão da empresa
  -- para o painel manter o histórico de atendimento.
  tenant_id          uuid references public.tenants(id) on delete set null,
  tenant_name        varchar(200) not null,
  -- Sem FK para auth.users, pela mesma razão da MIGRATION_20/21: o usuário é
  -- apagado por esta própria funcionalidade.
  requested_by       uuid not null,
  requested_at       timestamptz not null default now(),
  export_requested   boolean not null,
  scheduled_for      timestamptz not null,

  status             text not null default 'pending'
                     check (status in ('pending','canceled','completed','failed')),

  -- Trilha de entrega do e-mail de exportação. A exclusão só roda com
  -- export_status = 'delivered' (ou sem exportação pedida).
  export_status      text not null default 'not_requested'
                     check (export_status in ('not_requested','pending','sent','delivered','failed')),
  export_sent_at     timestamptz,
  export_email_id    text,
  export_email_status text,
  export_delivered_at timestamptz,
  export_opened_at   timestamptz,
  export_delivery_manual boolean not null default false,
  -- Caminho do zip no bucket `exports`. Fica em `<tenant_id>/deletions/<id>.zip`:
  -- dentro da pasta da empresa (a policy do bucket faz cast de foldername[1] para
  -- uuid, então uma pasta 'deletions/' na RAIZ quebraria a leitura do bucket), mas
  -- numa subpasta, que a limpeza da pasta do tenant não varre. É o que mantém o
  -- link do e-mail vivo depois de a empresa ser apagada; a varredura de retenção
  -- da process-deletion-requests apaga pelo caminho guardado aqui.
  export_zip_path    text,

  -- Dado pessoal: existe para o dono ligar durante a janela, e é APAGADO na
  -- execução da exclusão (ver delete_tenant_cascade, seção 7).
  contact_name       text,
  contact_phone      text,
  contact_email      text,
  contact_erased_at  timestamptz,

  canceled_at        timestamptz,
  canceled_by        uuid,
  canceled_by_admin  boolean not null default false,
  completed_at       timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.account_deletion_requests is
  'Solicitações de exclusão de conta com data marcada (48h sem exportação, 10 dias úteis com). Enquanto pending, a empresa fica em somente-leitura (ver tenant_has_access).';

-- Rede de segurança de idempotência: `create table if not exists` não acrescenta
-- coluna a uma tabela que já existe (caso de quem rodou uma versão anterior deste
-- arquivo). Mesmo padrão de `add column if not exists` das MIGRATIONs 01 e 21.
alter table public.account_deletion_requests add column if not exists export_email_id text;
alter table public.account_deletion_requests add column if not exists export_email_status text;
alter table public.account_deletion_requests add column if not exists export_delivered_at timestamptz;
alter table public.account_deletion_requests add column if not exists export_opened_at timestamptz;
alter table public.account_deletion_requests add column if not exists export_delivery_manual boolean not null default false;
alter table public.account_deletion_requests add column if not exists export_zip_path text;

-- Uma pendente por empresa. É o que torna a delete-account idempotente.
create unique index if not exists uq_deletion_request_pending
  on public.account_deletion_requests (tenant_id)
  where status = 'pending';

-- Varredura do cron.
create index if not exists idx_deletion_request_due
  on public.account_deletion_requests (status, scheduled_for);

-- Consulta por tenant (tenant_has_access roda POR LINHA dentro das policies).
create index if not exists idx_deletion_request_tenant_status
  on public.account_deletion_requests (tenant_id, status);

-- Webhook do Resend casa o evento pelo id do e-mail.
create index if not exists idx_deletion_request_email_id
  on public.account_deletion_requests (export_email_id)
  where export_email_id is not null;

alter table public.account_deletion_requests enable row level security;

-- Leitura para qualquer membro: o funcionário precisa saber POR QUE o app travou.
drop policy if exists deletion_request_member_read on public.account_deletion_requests;
create policy deletion_request_member_read on public.account_deletion_requests
  for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));

drop policy if exists deletion_request_admin_all on public.account_deletion_requests;
create policy deletion_request_admin_all on public.account_deletion_requests
  for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Nenhuma policy de INSERT/UPDATE/DELETE para o cliente: a escrita passa pelas
-- RPCs security definer abaixo e pelo service_role das Edge Functions. Assim não
-- há como forjar uma solicitação (nem cancelar a dos outros) pela API REST.

-- ---------------------------------------------------------------------
-- 3) SOMENTE-LEITURA — uma cláusula em tenant_has_access desliga a escrita
-- ---------------------------------------------------------------------
-- Mantém EXATAMENTE a regra da MIGRATION_11 e acrescenta a solicitação pendente.
create or replace function public.tenant_has_access(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.subscriptions s
     where s.tenant_id = p_tenant_id
       and s.blocked_by_owner = false
       and (
            (s.status = 'trial'
             and (s.trial_ends_at is null or now() < s.trial_ends_at))
         or (s.status = 'active'
             and (s.current_period_end is null
                  or now() < s.current_period_end + interval '48 hours'))
       )
  )
  and not exists (
    select 1
      from public.account_deletion_requests r
     where r.tenant_id = p_tenant_id
       and r.status = 'pending'
  );
$$;

comment on function public.tenant_has_access(uuid) is
  'true = a empresa pode ESCREVER agora (assinatura válida, não bloqueada pelo dono e SEM solicitação de exclusão pendente). Usada nas policies de escrita. get_access_status reporta allowed=true no caso da exclusão pendente — assimetria deliberada, ver MIGRATION_24.';

revoke all on function public.tenant_has_access(uuid) from public;
grant execute on function public.tenant_has_access(uuid) to authenticated;

-- Dreno do sync: enquanto a solicitação está pendente, o que já existe no
-- aparelho ainda consegue subir.
create or replace function public.tenant_sync_drain(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.account_deletion_requests r
     where r.tenant_id = p_tenant_id
       and r.status = 'pending'
  );
$$;

comment on function public.tenant_sync_drain(uuid) is
  'true enquanto há solicitação de exclusão pendente. Habilita SOMENTE o INSERT de venda/comanda, para o sync offline terminar de subir o que já existia antes do somente-leitura.';

revoke all on function public.tenant_sync_drain(uuid) from public;
grant execute on function public.tenant_sync_drain(uuid) to authenticated;

-- Policies permissivas se somam com OR — mesmo mecanismo que a MIGRATION_11 usa
-- para manter o SELECT vivo enquanto o write nega.
drop policy if exists sales_drain_insert on public.sales;
create policy sales_drain_insert on public.sales for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_sync_drain(tenant_id));

drop policy if exists sale_items_drain_insert on public.sale_items;
create policy sale_items_drain_insert on public.sale_items for insert to authenticated
  with check (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_sync_drain(s.tenant_id)));

drop policy if exists tabs_drain_insert on public.tabs;
create policy tabs_drain_insert on public.tabs for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_sync_drain(tenant_id));

drop policy if exists tab_items_drain_insert on public.tab_items;
create policy tab_items_drain_insert on public.tab_items for insert to authenticated
  with check (exists (select 1 from public.tabs t
                      where t.client_id = tab_client_id
                        and t.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_sync_drain(t.tenant_id)));

-- ---------------------------------------------------------------------
-- 4) create_sale — mensagem certa para o caso novo
-- ---------------------------------------------------------------------
-- A função é security INVOKER, então a RLS vale (e o dreno acima permitiria o
-- INSERT). Mas a guarda explícita de assinatura passaria a dizer "assinatura
-- inativa" para quem agendou a exclusão, mandando o operador regularizar um
-- pagamento que não tem nada a ver com o problema. Mesma razão pela qual a
-- guarda existe (MIGRATION_12): a mensagem.
-- Cópia fiel da MIGRATION_12 com UMA guarda nova antes da de assinatura.
create or replace function public.create_sale(
  p_tenant_id        uuid,
  p_client_id        uuid,
  p_payment_method   text,
  p_consumption_mode text,
  p_items            jsonb,
  p_tab_client_id    uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total numeric(12,2);
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'venda sem itens';
  end if;

  -- Idempotência antes das guardas: retry de venda já gravada não pode falhar.
  if exists (select 1 from public.sales where client_id = p_client_id) then
    return p_client_id;
  end if;

  -- Guarda nova (MIGRATION_24): exclusão agendada não é problema de cobrança.
  if exists (select 1 from public.account_deletion_requests r
              where r.tenant_id = p_tenant_id and r.status = 'pending') then
    raise exception 'exclusão de conta agendada: cancele a solicitação para voltar a vender';
  end if;

  -- Guarda de assinatura (A06-01). A RLS já barraria; isto é pela mensagem.
  if not public.tenant_has_access(p_tenant_id) then
    raise exception 'assinatura inativa: regularize para continuar vendendo';
  end if;

  -- Guarda de preço (A06-02).
  if p_tab_client_id is null then
    if exists (
      select 1
        from jsonb_array_elements(p_items) as i
       where not exists (
         select 1
           from public.products pr
          where pr.client_id = (i->>'product_client_id')::uuid
            and pr.tenant_id = p_tenant_id
            and abs((i->>'unit_price')::numeric - pr.price) <= 0.01
       )
    ) then
      raise exception 'preço divergente do cadastro do produto';
    end if;
  else
    if exists (
      select 1
        from jsonb_array_elements(p_items) as i
       where not exists (
         select 1
           from public.tab_items ti
          where ti.tab_client_id = p_tab_client_id
            and ti.product_client_id = (i->>'product_client_id')::uuid
            and abs((i->>'unit_price')::numeric - ti.unit_price) <= 0.01
       )
    ) then
      raise exception 'preço divergente da comanda';
    end if;
  end if;

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_price')::numeric), 0)
    into v_total
    from jsonb_array_elements(p_items) as i;

  insert into public.sales (
    tenant_id, client_id, total_amount, payment_method, consumption_mode, sale_date, synced_at
  )
  values (
    p_tenant_id, p_client_id, v_total, p_payment_method, p_consumption_mode, now(), now()
  );

  insert into public.sale_items (client_id, sale_client_id, product_client_id, quantity, unit_price)
  select
    gen_random_uuid(),
    p_client_id,
    (i->>'product_client_id')::uuid,
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric
  from jsonb_array_elements(p_items) as i;

  if p_tab_client_id is not null then
    update public.tabs
       set status = 'closed', closed_at = now(), sale_client_id = p_client_id, updated_at = now()
     where client_id = p_tab_client_id
       and tenant_id = p_tenant_id
       and status = 'open';
    if not found then
      raise exception 'comanda não está aberta (já foi fechada em outro aparelho?)';
    end if;
  end if;

  return p_client_id;
end;
$$;

revoke all on function public.create_sale(uuid, uuid, text, text, jsonb, uuid) from public;
grant execute on function public.create_sale(uuid, uuid, text, text, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5) get_access_status — informa o somente-leitura SEM bloquear a tela
-- ---------------------------------------------------------------------
-- Cópia da versão vigente (docs/assinatura-app/MIGRATION_03_activation_and_reminders.sql)
-- acrescentando readOnly + deletion. `allowed` NÃO muda: ver DECISÕES no cabeçalho.
create or replace function public.get_access_status(p_tenant_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid;
  v_sub     public.subscriptions;
  v_req     public.account_deletion_requests;
  v_allowed boolean := false;
  v_reason  text;
  v_ends    timestamptz;
  v_days    int := 0;
  v_deletion jsonb := null;
begin
  if p_tenant_id is not null then
    if not (p_tenant_id in (select public.user_tenant_ids())) then
      return jsonb_build_object('allowed', false, 'status', null, 'reason', 'forbidden',
                                'endsAt', null, 'daysRemaining', 0,
                                'readOnly', false, 'deletion', null);
    end if;
    v_tenant := p_tenant_id;
  else
    select tid into v_tenant from (select public.user_tenant_ids() as tid) s limit 1;
  end if;

  if v_tenant is null then
    return jsonb_build_object('allowed', false, 'status', null, 'reason', 'no_tenant',
                              'endsAt', null, 'daysRemaining', 0,
                              'readOnly', false, 'deletion', null);
  end if;

  select * into v_sub from public.subscriptions where tenant_id = v_tenant;
  if not found then
    return jsonb_build_object('allowed', false, 'status', null, 'reason', 'no_subscription',
                              'endsAt', null, 'daysRemaining', 0,
                              'readOnly', false, 'deletion', null);
  end if;

  if v_sub.blocked_by_owner then
    v_allowed := false; v_reason := 'blocked_by_owner';
  elsif v_sub.status = 'canceled' then
    v_allowed := false; v_reason := 'canceled';
  elsif v_sub.status = 'past_due' then
    v_allowed := false; v_reason := 'payment_overdue'; v_ends := v_sub.current_period_end;
  elsif v_sub.status = 'trial' then
    v_ends := v_sub.trial_ends_at;
    if v_ends is not null and now() >= v_ends then
      v_allowed := false; v_reason := 'trial_expired';
    else
      v_allowed := true; v_reason := 'trial';
    end if;
  elsif v_sub.status = 'active' then
    v_ends := v_sub.current_period_end;
    if v_ends is not null and now() >= v_ends + interval '48 hours' then
      v_allowed := false; v_reason := 'payment_overdue';
    else
      v_allowed := true; v_reason := 'active';
    end if;
  else
    v_allowed := false; v_reason := 'unknown';
  end if;

  if v_ends is not null then
    v_days := greatest(0, ceil(extract(epoch from (v_ends - now())) / 86400))::int;
  end if;

  select * into v_req
    from public.account_deletion_requests
   where tenant_id = v_tenant and status = 'pending'
   limit 1;

  if found then
    v_deletion := jsonb_build_object(
      'requestId',       v_req.id,
      'requestedAt',     v_req.requested_at,
      'scheduledFor',    v_req.scheduled_for,
      'exportRequested', v_req.export_requested,
      'exportStatus',    v_req.export_status,
      'contactEmail',    v_req.contact_email,
      'canCancel',       public.is_tenant_owner(v_tenant)
    );
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'status', v_sub.status,
    'reason', v_reason,
    'endsAt', v_ends,
    'daysRemaining', v_days,
    -- Somente-leitura é um estado À PARTE de "bloqueado": a tela continua aberta.
    'readOnly', v_deletion is not null,
    'deletion', v_deletion
  );
end; $$;

-- ---------------------------------------------------------------------
-- 6) RPCs do cliente
-- ---------------------------------------------------------------------
create or replace function public.deletion_request_preview()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  -- As DUAS datas vêm do servidor: o app é offline-first, o relógio do aparelho é
  -- manipulável e os três clientes não podem divergir da data que será gravada.
  return jsonb_build_object(
    'dateNoExport',   now() + interval '48 hours',
    'dateWithExport', public.add_business_days(now(), 10)
  );
end; $$;

revoke all on function public.deletion_request_preview() from public, anon;
grant execute on function public.deletion_request_preview() to authenticated;

create or replace function public.cancel_account_deletion(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_tenant_owner(p_tenant_id) then
    raise exception 'forbidden: apenas o dono da empresa pode cancelar a solicitação';
  end if;

  update public.account_deletion_requests
     set status            = 'canceled',
         canceled_at       = now(),
         canceled_by       = auth.uid(),
         canceled_by_admin = false,
         updated_at        = now()
   where tenant_id = p_tenant_id
     and status = 'pending'
  returning id into v_id;

  if v_id is null then
    raise exception 'nenhuma solicitação pendente para esta empresa';
  end if;

  return jsonb_build_object('ok', true, 'requestId', v_id);
end; $$;

revoke all on function public.cancel_account_deletion(uuid) from public, anon;
grant execute on function public.cancel_account_deletion(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7) delete_tenant_cascade — preserva a solicitação, apaga o dado pessoal
-- ---------------------------------------------------------------------
-- Quinta versão (18 -> 19 -> 21 -> 22 -> 24). Mesma ordem explícita da 22, com o
-- passo 6.5 novo. Tem de rodar ANTES do delete de tenants: depois, o SET NULL já
-- teria zerado tenant_id e o update não acharia a linha.
create or replace function public.delete_tenant_cascade(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) Itens de venda e de comanda.
  delete from public.sale_items si
   using public.sales s
   where s.client_id = si.sale_client_id and s.tenant_id = p_tenant_id;

  delete from public.tab_items ti
   using public.tabs t
   where t.client_id = ti.tab_client_id and t.tenant_id = p_tenant_id;

  -- 2) Filhas diretas de products / suppliers.
  delete from public.product_day_visibility pdv
   using public.products pr
   where pr.client_id = pdv.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_supplier_price_history h
   using public.products pr
   where pr.client_id = h.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.products pr
   where pr.client_id = ps.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.suppliers su
   where su.client_id = ps.supplier_client_id and su.tenant_id = p_tenant_id;

  -- 3) Tabelas com tenant_id que apontam para products/suppliers.
  delete from public.stock_items   where tenant_id = p_tenant_id;
  delete from public.stock_entries where tenant_id = p_tenant_id;

  -- 4) Vendas e comandas.
  delete from public.sales where tenant_id = p_tenant_id;
  delete from public.tabs  where tenant_id = p_tenant_id;

  -- 5) Catálogo.
  delete from public.products   where tenant_id = p_tenant_id;
  delete from public.suppliers  where tenant_id = p_tenant_id;
  delete from public.categories where tenant_id = p_tenant_id;

  -- 6) Relatórios e exportações ANTES da empresa (referenciam tenant_members,
  --    que cascateia do mesmo delete — MIGRATION_18).
  delete from public.reports      where tenant_id = p_tenant_id;
  delete from public.data_exports where tenant_id = p_tenant_id;

  -- 6.5) A solicitação NÃO é apagada: vira histórico de atendimento no painel.
  --      Mas o dado pessoal de contato some junto com o resto — guardar nome e
  --      telefone de quem pediu para sumir contradiz o próprio pedido.
  update public.account_deletion_requests
     set status       = 'completed',
         completed_at = coalesce(completed_at, now()),
         updated_at   = now()
   where tenant_id = p_tenant_id
     and status in ('pending', 'failed');

  -- O contato some de TODAS as solicitações desta empresa, inclusive das
  -- CANCELADAS: a razão de guardar nome e telefone era ligar para o cliente
  -- durante a janela; com a empresa apagada não há mais para quem ligar.
  update public.account_deletion_requests
     set contact_name      = null,
         contact_phone     = null,
         contact_email     = null,
         contact_erased_at = coalesce(contact_erased_at, now()),
         updated_at        = now()
   where tenant_id = p_tenant_id
     and contact_erased_at is null;

  -- 7) O resto cascateia de tenants.
  delete from public.tenants where id = p_tenant_id;
end;
$$;

revoke execute on function public.delete_tenant_cascade(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8) RPCs do painel do dono
-- ---------------------------------------------------------------------
create or replace function public.admin_list_deletion_requests(
  p_status text    default 'pending',
  p_export boolean default null,
  p_search text    default null,
  p_limit  int     default 100,
  p_offset int     default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  return coalesce((
    select jsonb_agg(row_obj order by (row_obj->>'scheduledFor'))
    from (
      select jsonb_build_object(
        'id',               r.id,
        'tenantId',         r.tenant_id,
        'tenantName',       r.tenant_name,
        'requestedAt',      r.requested_at,
        'scheduledFor',     r.scheduled_for,
        'exportRequested',  r.export_requested,
        'status',           r.status,
        'exportStatus',     r.export_status,
        'exportSentAt',     r.export_sent_at,
        'exportDeliveredAt', r.export_delivered_at,
        'exportOpenedAt',   r.export_opened_at,
        'exportDeliveryManual', r.export_delivery_manual,
        'contactName',      r.contact_name,
        'contactPhone',     r.contact_phone,
        'contactEmail',     r.contact_email,
        'canceledAt',       r.canceled_at,
        'canceledByAdmin',  r.canceled_by_admin,
        'completedAt',      r.completed_at,
        'lastError',        r.last_error
      ) as row_obj
      from public.account_deletion_requests r
     where (p_status is null or p_status = 'all' or r.status = p_status)
       and (p_export is null or r.export_requested = p_export)
       and (
         p_search is null or p_search = '' or
         r.tenant_name   ilike '%' || p_search || '%' or
         r.contact_name  ilike '%' || p_search || '%' or
         r.contact_email ilike '%' || p_search || '%'
       )
     order by r.scheduled_for
     limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset)
    ) q
  ), '[]'::jsonb);
end; $$;

create or replace function public.admin_deletion_requests_pending_count()
returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  return (select count(*)::int from public.account_deletion_requests where status = 'pending');
end; $$;

create or replace function public.admin_cancel_deletion_request(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  update public.account_deletion_requests
     set status            = 'canceled',
         canceled_at       = now(),
         canceled_by       = auth.uid(),
         canceled_by_admin = true,
         updated_at        = now()
   where id = p_id
     and status in ('pending', 'failed')
  returning id into v_id;

  if v_id is null then
    raise exception 'solicitação não encontrada ou já resolvida';
  end if;

  return jsonb_build_object('ok', true);
end; $$;

-- Válvula de escape da trava de entrega: o dono mandou o arquivo por fora, ou o
-- webhook do Resend nunca chegou. Marca a entrega para destravar a exclusão.
create or replace function public.admin_mark_export_sent(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  update public.account_deletion_requests
     set export_status         = 'delivered',
         export_sent_at        = coalesce(export_sent_at, now()),
         export_delivered_at   = now(),
         export_delivery_manual = true,
         status                = case when status = 'failed' then 'pending' else status end,
         updated_at            = now()
   where id = p_id
     and export_requested = true
  returning id into v_id;

  if v_id is null then
    raise exception 'solicitação não encontrada ou sem exportação pedida';
  end if;

  return jsonb_build_object('ok', true);
end; $$;

-- Overview e detalhe ganham o bloco deletionRequest (null quando não houver).
-- Cópia fiel de docs/assinatura-app/MIGRATION_01 e MIGRATION_04 + o bloco novo.
create or replace function public.admin_list_tenants_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  return coalesce((
    select jsonb_agg(row_obj order by row_obj->>'name')
    from (
      select jsonb_build_object(
        'tenantId',      t.id,
        'name',          t.name,
        'status',        s.status,
        'enabled',       not s.blocked_by_owner,
        'monthlyPrice',  s.monthly_price,
        'paymentMethod', s.payment_method,
        'endsAt',        case when s.status = 'trial' then s.trial_ends_at else s.current_period_end end,
        'trialStartedAt', s.trial_started_at,
        'contractStartedAt', s.contract_started_at,
        'deviceCount',   (select count(*) from public.tenant_devices d where d.tenant_id = t.id),
        'lastPaymentAt', (select max(p.paid_at) from public.payments p where p.tenant_id = t.id),
        'deletionRequest', (
          select jsonb_build_object(
            'id',              r.id,
            'scheduledFor',    r.scheduled_for,
            'exportRequested', r.export_requested,
            'exportStatus',    r.export_status,
            'status',          r.status
          )
          from public.account_deletion_requests r
          where r.tenant_id = t.id and r.status = 'pending'
          limit 1
        )
      ) as row_obj
      from public.tenants t
      join public.subscriptions s on s.tenant_id = t.id
    ) q
  ), '[]'::jsonb);
end; $$;

create or replace function public.admin_tenant_detail(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  select jsonb_build_object(
    'tenantId',      t.id,
    'name',          t.name,
    'status',        s.status,
    'enabled',       not s.blocked_by_owner,
    'monthlyPrice',  s.monthly_price,
    'paymentMethod', s.payment_method,
    'endsAt',        case when s.status = 'trial' then s.trial_ends_at else s.current_period_end end,
    'trialStartedAt', s.trial_started_at,
    'contractStartedAt', s.contract_started_at,
    'deviceCount',   (select count(*) from public.tenant_devices d where d.tenant_id = t.id),
    'lastPaymentAt', (select max(p.paid_at) from public.payments p where p.tenant_id = t.id),
    'cnpj',          t.cnpj,
    'phone',         t.phone,
    'email',         u.email,
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'deviceId',    d.device_id,
        'platform',    d.platform,
        'active',      d.active,
        'firstSeenAt', d.first_seen_at,
        'lastSeenAt',  d.last_seen_at
      ) order by d.last_seen_at desc)
      from public.tenant_devices d where d.tenant_id = t.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',             p.id,
        'tenantId',       p.tenant_id,
        'amount',         p.amount,
        'method',         p.method,
        'paidAt',         p.paid_at,
        'referenceMonth', p.reference_month,
        'status',         p.status
      ) order by p.paid_at desc)
      from public.payments p where p.tenant_id = t.id
    ), '[]'::jsonb),
    'deletionRequest', (
      select jsonb_build_object(
        'id',                r.id,
        'tenantId',          r.tenant_id,
        'tenantName',        r.tenant_name,
        'requestedAt',       r.requested_at,
        'scheduledFor',      r.scheduled_for,
        'exportRequested',   r.export_requested,
        'status',            r.status,
        'exportStatus',      r.export_status,
        'exportSentAt',      r.export_sent_at,
        'exportDeliveredAt', r.export_delivered_at,
        'exportDeliveryManual', r.export_delivery_manual,
        'contactName',       r.contact_name,
        'contactPhone',      r.contact_phone,
        'contactEmail',      r.contact_email,
        'lastError',         r.last_error
      )
      from public.account_deletion_requests r
      where r.tenant_id = t.id and r.status in ('pending','failed')
      order by r.requested_at desc
      limit 1
    )
  ) into v_result
  from public.tenants t
  join public.subscriptions s on s.tenant_id = t.id
  left join auth.users u on u.id = t.owner_user_id
  where t.id = p_tenant_id;

  return v_result; -- null se a empresa não existir
end; $$;

-- ---------------------------------------------------------------------
-- 9) O gatilho do cron
-- ---------------------------------------------------------------------
-- Mesma cadeia de send_subscription_due_reminders: pg_cron -> esta função ->
-- Vault -> pg_net -> Edge Function. Quem exclui é a Edge Function, porque apagar
-- de auth.users exige service_role, que não existe do lado do Postgres.
create or replace function public.run_due_account_deletions()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_token     text;
  v_last_day  date;
begin
  -- Alarme de calendário: a semeadura de feriados acaba em 2036. Sem este aviso,
  -- o prazo de 10 dias úteis volta a ignorar feriados em silêncio.
  select max(day) into v_last_day from public.holidays;
  if v_last_day is null or v_last_day < (current_date + interval '1 year')::date then
    raise warning 'public.holidays semeada só até %: rode seed_br_holidays para os próximos anos', v_last_day;
  end if;

  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'deletion_worker_token';

  if v_token is null then
    raise notice 'deletion_worker_token ausente no Vault: nada a fazer';
    return;
  end if;

  if not exists (
    select 1 from public.account_deletion_requests
     where status = 'pending' and scheduled_for <= now()
  ) then
    return;
  end if;

  perform net.http_post(
    url     := 'https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/process-deletion-requests?token=' || v_token,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('source', 'cron')
  );
end; $$;

revoke execute on function public.run_due_account_deletions() from public, authenticated, anon;

create or replace function public.admin_run_due_account_deletions_now()
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  perform public.run_due_account_deletions();
end; $$;

-- ---------------------------------------------------------------------
-- 10) GRANTS
-- ---------------------------------------------------------------------
grant execute on function public.admin_list_deletion_requests(text, boolean, text, int, int) to authenticated;
grant execute on function public.admin_deletion_requests_pending_count() to authenticated;
grant execute on function public.admin_cancel_deletion_request(uuid) to authenticated;
grant execute on function public.admin_mark_export_sent(uuid) to authenticated;
grant execute on function public.admin_run_due_account_deletions_now() to authenticated;
grant execute on function public.easter_sunday(int) to authenticated;
grant execute on function public.add_business_days(timestamptz, int) to authenticated;
revoke all on function public.seed_br_holidays(int, int) from public, anon, authenticated;

commit;

-- =====================================================================
-- PASSOS MANUAIS (FORA DA TRANSAÇÃO)
-- =====================================================================
-- 1) Token do worker no Vault (o MESMO valor vai em DELETION_WORKER_TOKEN nos
--    secrets da Edge Function):
--    select vault.create_secret('<token-aleatorio-forte>', 'deletion_worker_token');
--
-- 2) Agendar de HORA EM HORA (não diário: a promessa de 48h é em horas):
--    select cron.schedule(
--      'process-deletion-requests', '0 * * * *',
--      $$select public.run_due_account_deletions();$$);
--
-- 3) Secrets da Edge Function (RESEND_API_KEY e EMAIL_FROM já existem):
--    supabase secrets set DELETION_WORKER_TOKEN=<o mesmo do passo 1>
--    supabase secrets set RESEND_WEBHOOK_SECRET=<secret do webhook no painel do Resend>
--
-- =====================================================================
-- VERIFICAÇÃO (PÓS-MIGRAÇÃO)
-- =====================================================================
-- 1) Feriados: 13 linhas por ano, 2026-2036 (143 no total)?
--    select extract(year from day) as ano, count(*) from public.holidays group by 1 order by 1;
--
-- 2) Móveis de 2027 (Páscoa em 28/03): Carnaval 08 e 09/02, Sexta-feira Santa
--    26/03, Corpus Christi 27/05.
--    select day, name from public.holidays where day between '2027-01-01' and '2027-12-31' order by day;
--
-- 3) Dias úteis pulando Natal e Ano-Novo -> 05/01/2027:
--    select public.add_business_days('2026-12-18'::timestamptz, 10);
--
-- 4) Preview (48h e 10 dias úteis):
--    select public.deletion_request_preview();
--
-- 5) Somente-leitura. Com uma solicitação pendente inserida à mão para um tenant
--    de teste, tenant_has_access deve virar FALSE e get_access_status deve
--    continuar com allowed=true + readOnly=true:
--    select public.tenant_has_access('<tenant>');
--    select public.get_access_status('<tenant>');
--
-- 6) As policies de dreno existem?
--    select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public' and policyname like '%_drain_insert' order by 1;
--
-- TESTE FUNCIONAL (obrigatório — pela API, NÃO pelo SQL Editor, que roda como
-- postgres e pula a RLS; mesma armadilha da MIGRATION_11 e da 22):
--   a) com solicitação pendente, INSERT em sales/sale_items via REST com token de
--      membro -> deve PASSAR (dreno do sync);
--   b) UPDATE de products, INSERT em stock_entries e DELETE de sales -> devem FALHAR;
--   c) create_sale -> deve falhar com 'exclusão de conta agendada: cancele a
--      solicitação para voltar a vender' (e NÃO com 'assinatura inativa');
--   d) select public.cancel_account_deletion('<tenant>') como owner -> escrita
--      volta ao normal em todos os pontos acima.
