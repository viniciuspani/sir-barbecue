-- =====================================================================
-- Sir Barbecue — SCHEMA DE LICENCIAMENTO SAAS (assinatura no centro)
-- Complemento do SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql (MESMO projeto Supabase).
--
-- Cobre: trial + assinatura por empresa, vínculo device↔empresa, pagamentos,
-- despesas da aplicação, super-admin (dono) e o botão on/off de bloqueio.
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run. IDEMPOTENTE.
-- Pré-requisito: o schema multi-tenant já aplicado (tabelas tenants/tenant_members,
--   funções user_tenant_ids()/is_tenant_owner()/update_updated_at_column()).
--
-- Modelo: TODA empresa (tenant) tem 1 assinatura. O trial é só o primeiro estado
--   (status='trial'). Do trial ao pago muda apenas o status. O deviceId é vinculado
--   à empresa. O bloqueio (por atraso/cancelamento/on-off do dono) é decidido no
--   servidor pela RPC get_access_status().
-- =====================================================================

-- =====================================================================
-- FASE 1 — TABELAS + ÍNDICES
-- =====================================================================

-- 0) Super-admins (donos da aplicação). Base do acesso privilegiado.
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 1) Assinatura — 1 por empresa. Trial é o primeiro estado.
create table if not exists public.subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null unique references public.tenants (id) on delete cascade,
  status             varchar(20) not null default 'trial'
                       check (status in ('trial','active','past_due','canceled')),
  -- Kill switch do dono (on/off). true = acesso bloqueado manualmente.
  blocked_by_owner   boolean not null default false,
  trial_ends_at      timestamptz,                 -- fim do período de teste
  current_period_end timestamptz,                 -- fim do período pago vigente
  plan               varchar(50) not null default 'mensal',
  monthly_price      numeric(10,2) not null default 0 check (monthly_price >= 0),
  payment_method     varchar(20)
                       check (payment_method in ('pix','cash','credit_card','debit_card','boleto')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 2) Dispositivos vinculados à empresa (para identificação e bloqueio).
create table if not exists public.tenant_devices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  device_id     varchar(200) not null,
  platform      varchar(20),                       -- 'android' | 'ios'
  active        boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint tenant_devices_unique unique (tenant_id, device_id)
);

-- 3) Pagamentos recebidos (razão financeira — controle manual).
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  amount          numeric(10,2) not null check (amount >= 0),
  method          varchar(20) not null
                    check (method in ('pix','cash','credit_card','debit_card','boleto')),
  paid_at         timestamptz not null default now(),
  reference_month varchar(7) not null,             -- 'YYYY-MM'
  status          varchar(20) not null default 'paid' check (status in ('paid','pending')),
  created_at      timestamptz not null default now()
);

-- 4) Despesas da aplicação (serviços que a app consome).
create table if not exists public.app_expenses (
  id          uuid primary key default gen_random_uuid(),
  name        varchar(200) not null,
  category    varchar(100) not null default 'Geral',
  amount      numeric(10,2) not null check (amount >= 0),
  incurred_at timestamptz not null default now(),
  recurring   boolean not null default false,      -- true = mensal recorrente
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Índices
create index if not exists idx_subscriptions_status      on public.subscriptions (status);
create index if not exists idx_tenant_devices_tenant     on public.tenant_devices (tenant_id);
create index if not exists idx_tenant_devices_device     on public.tenant_devices (device_id);
create index if not exists idx_payments_tenant           on public.payments (tenant_id, paid_at desc);
create index if not exists idx_payments_ref_month        on public.payments (reference_month);
create index if not exists idx_app_expenses_incurred     on public.app_expenses (incurred_at desc);

-- =====================================================================
-- FASE 2 — TRIGGERS updated_at + BOOTSTRAP DA ASSINATURA (TRIAL)
-- =====================================================================

-- updated_at automático (reusa a função do schema base)
do $$
declare t text;
begin
  foreach t in array array['subscriptions','app_expenses'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on public.%1$s
         for each row execute function public.update_updated_at_column();', t);
  end loop;
end $$;

-- Ao criar a EMPRESA → cria a assinatura em TRIAL (7 dias).
-- Trigger dedicado (não mexe no handle_new_user): cobre empresas criadas por
-- QUALQUER caminho, não só o bootstrap do primeiro usuário.
create or replace function public.seed_tenant_subscription()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions (tenant_id, status, trial_ends_at)
    values (new.id, 'trial', now() + interval '7 days')
  on conflict (tenant_id) do nothing;
  return new;
end; $$;
drop trigger if exists trg_seed_tenant_subscription on public.tenants;
create trigger trg_seed_tenant_subscription
  after insert on public.tenants
  for each row execute function public.seed_tenant_subscription();

-- Backfill: empresas que já existem e ainda não têm assinatura entram em trial.
insert into public.subscriptions (tenant_id, status, trial_ends_at)
  select t.id, 'trial', now() + interval '7 days'
    from public.tenants t
    left join public.subscriptions s on s.tenant_id = t.id
   where s.tenant_id is null
on conflict (tenant_id) do nothing;

-- =====================================================================
-- FASE 3 — SUPER-ADMIN HELPER + ROW LEVEL SECURITY
-- =====================================================================

-- O usuário logado é dono da aplicação? SECURITY DEFINER → lê platform_admins
-- ignorando a RLS (evita recursão), igual ao padrão is_tenant_owner().
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.platform_admins pa where pa.user_id = auth.uid()
  );
$$;

-- Habilita RLS em tudo
do $$
declare t text;
begin
  foreach t in array array[
    'platform_admins','subscriptions','tenant_devices','payments','app_expenses'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- platform_admins: só super-admin enxerga/gerencia (sem recursão via helper).
drop policy if exists admin_all on public.platform_admins;
create policy admin_all on public.platform_admins for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- subscriptions:
--   • cada empresa LÊ apenas a própria assinatura (para o app saber o status);
--   • super-admin lê/escreve TODAS (gestão + on/off). Empresa NÃO escreve.
drop policy if exists subscriptions_member_read on public.subscriptions;
create policy subscriptions_member_read on public.subscriptions for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
drop policy if exists subscriptions_admin_all on public.subscriptions;
create policy subscriptions_admin_all on public.subscriptions for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- tenant_devices: acesso direto só para super-admin (o app usa RPC SECURITY DEFINER).
drop policy if exists tenant_devices_admin_all on public.tenant_devices;
create policy tenant_devices_admin_all on public.tenant_devices for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- payments e app_expenses: exclusivos do super-admin (financeiro do negócio).
drop policy if exists payments_admin_all on public.payments;
create policy payments_admin_all on public.payments for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists app_expenses_admin_all on public.app_expenses;
create policy app_expenses_admin_all on public.app_expenses for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- =====================================================================
-- FASE 4 — RPCs DO APP CLIENTE (acesso + vínculo de device)
-- Retornam JSON em camelCase para casar com os tipos do app/painel.
-- =====================================================================

-- Veredito de acesso da empresa do usuário logado. Regra e hora 100% no
-- servidor (now()) — à prova de manipulação de relógio no aparelho.
create or replace function public.get_access_status(p_tenant_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid;
  v_sub     public.subscriptions;
  v_allowed boolean := false;
  v_reason  text;
  v_ends    timestamptz;
  v_days    int := 0;
begin
  -- Resolve a empresa do usuário logado (verifica associação se p_tenant_id vier).
  if p_tenant_id is not null then
    if not (p_tenant_id in (select public.user_tenant_ids())) then
      return jsonb_build_object('allowed', false, 'status', null, 'reason', 'forbidden',
                                'endsAt', null, 'daysRemaining', 0);
    end if;
    v_tenant := p_tenant_id;
  else
    select tid into v_tenant from (select public.user_tenant_ids() as tid) s limit 1;
  end if;

  if v_tenant is null then
    return jsonb_build_object('allowed', false, 'status', null, 'reason', 'no_tenant',
                              'endsAt', null, 'daysRemaining', 0);
  end if;

  select * into v_sub from public.subscriptions where tenant_id = v_tenant;
  if not found then
    return jsonb_build_object('allowed', false, 'status', null, 'reason', 'no_subscription',
                              'endsAt', null, 'daysRemaining', 0);
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
    if v_ends is not null and now() >= v_ends then
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

  return jsonb_build_object(
    'allowed', v_allowed,
    'status', v_sub.status,
    'reason', v_reason,
    'endsAt', v_ends,
    'daysRemaining', v_days
  );
end; $$;

-- Vincula (ou atualiza) o dispositivo à empresa do usuário logado.
create or replace function public.bind_device(
  p_device_id text,
  p_platform  text default null,
  p_tenant_id uuid default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if p_tenant_id is not null then
    if not (p_tenant_id in (select public.user_tenant_ids())) then
      raise exception 'forbidden: empresa não pertence ao usuário';
    end if;
    v_tenant := p_tenant_id;
  else
    select tid into v_tenant from (select public.user_tenant_ids() as tid) s limit 1;
  end if;

  if v_tenant is null then
    raise exception 'sem empresa para vincular o dispositivo';
  end if;

  insert into public.tenant_devices (tenant_id, device_id, platform)
    values (v_tenant, p_device_id, p_platform)
  on conflict (tenant_id, device_id)
    do update set last_seen_at = now(),
                  platform = coalesce(excluded.platform, public.tenant_devices.platform);
end; $$;

grant execute on function public.get_access_status(uuid) to authenticated;
grant execute on function public.bind_device(text, text, uuid) to authenticated;

-- =====================================================================
-- FASE 5 — RPCs DE ADMINISTRAÇÃO (painel do dono)
-- Todas validam is_platform_admin() e retornam camelCase para o painel web.
-- =====================================================================

-- Botão on/off: liga/desliga o acesso da empresa (blocked_by_owner).
create or replace function public.admin_set_tenant_access(p_tenant_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  update public.subscriptions
     set blocked_by_owner = not p_enabled, updated_at = now()
   where tenant_id = p_tenant_id;
  if not found then
    raise exception 'assinatura não encontrada para a empresa %', p_tenant_id;
  end if;
end; $$;

-- Lista de clientes (visão geral).
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
        'deviceCount',   (select count(*) from public.tenant_devices d where d.tenant_id = t.id),
        'lastPaymentAt', (select max(p.paid_at) from public.payments p where p.tenant_id = t.id)
      ) as row_obj
      from public.tenants t
      join public.subscriptions s on s.tenant_id = t.id
    ) q
  ), '[]'::jsonb);
end; $$;

-- Detalhe de um cliente (assinatura + dispositivos + pagamentos).
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
    'deviceCount',   (select count(*) from public.tenant_devices d where d.tenant_id = t.id),
    'lastPaymentAt', (select max(p.paid_at) from public.payments p where p.tenant_id = t.id),
    'cnpj',          t.cnpj,
    'phone',         t.phone,
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
    ), '[]'::jsonb)
  ) into v_result
  from public.tenants t
  join public.subscriptions s on s.tenant_id = t.id
  where t.id = p_tenant_id;

  return v_result; -- null se a empresa não existir
end; $$;

-- Resumo financeiro: receita (pagamentos), despesa (recorrentes + do mês) e lucro.
create or replace function public.admin_finance_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_month         text := to_char(now(), 'YYYY-MM');
  v_revenue       numeric;
  v_recurring     numeric;
  v_expense_month numeric;
  v_active int; v_trial int; v_pastdue int;
  v_series jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  select coalesce(sum(amount), 0) into v_revenue
    from public.payments where reference_month = v_month and status = 'paid';

  select coalesce(sum(amount), 0) into v_recurring
    from public.app_expenses where recurring = true;

  select v_recurring + coalesce(sum(amount), 0) into v_expense_month
    from public.app_expenses
    where recurring = false and to_char(incurred_at, 'YYYY-MM') = v_month;

  select
    count(*) filter (where status = 'active'),
    count(*) filter (where status = 'trial'),
    count(*) filter (where status = 'past_due')
    into v_active, v_trial, v_pastdue
    from public.subscriptions;

  -- Série dos últimos 6 meses (receita real + despesa recorrente + não-recorrente do mês).
  select jsonb_agg(jsonb_build_object(
           'month',   m.ym,
           'revenue', coalesce(r.rev, 0),
           'expense', v_recurring + coalesce(e.exp, 0)
         ) order by m.ym)
    into v_series
  from (
    select to_char(date_trunc('month', now()) - (interval '1 month' * g), 'YYYY-MM') as ym
    from generate_series(0, 5) g
  ) m
  left join (
    select reference_month, sum(amount) rev
      from public.payments where status = 'paid' group by reference_month
  ) r on r.reference_month = m.ym
  left join (
    select to_char(incurred_at, 'YYYY-MM') ym, sum(amount) exp
      from public.app_expenses where recurring = false group by 1
  ) e on e.ym = m.ym;

  return jsonb_build_object(
    'monthlyRevenue', v_revenue,
    'monthlyExpense', v_expense_month,
    'monthlyProfit',  v_revenue - v_expense_month,
    'activeCount',    v_active,
    'trialCount',     v_trial,
    'pastDueCount',   v_pastdue,
    'series',         coalesce(v_series, '[]'::jsonb)
  );
end; $$;

grant execute on function public.admin_set_tenant_access(uuid, boolean) to authenticated;
grant execute on function public.admin_list_tenants_overview() to authenticated;
grant execute on function public.admin_tenant_detail(uuid) to authenticated;
grant execute on function public.admin_finance_summary() to authenticated;
grant execute on function public.is_platform_admin() to authenticated;

-- =====================================================================
-- FASE 6 — SEED DO SUPER-ADMIN (DONO) + CHECKLIST
-- =====================================================================

-- Marca o dono da aplicação como super-admin pelo e-mail (idempotente).
-- Se o e-mail ainda não estiver cadastrado no Auth, o SELECT não retorna nada
-- (no-op) — rode de novo após criar/logar a conta.
insert into public.platform_admins (user_id)
  select id from auth.users where email = 'viniciuspani@hotmail.com'
on conflict (user_id) do nothing;

-- =====================================================================
-- CHECKLIST PÓS-DEPLOY
--   1) Pré-requisito: SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql já aplicado.
--   2) Rodar este arquivo (idempotente — pode rodar 2x sem erro).
--   3) Garantir que seu usuário está em platform_admins (a seed acima resolve;
--      confira: select * from public.platform_admins;).
--   4) App mobile: após login, chamar bind_device(deviceId, platform, tenantId)
--      e get_access_status(tenantId) na abertura/foreground.
--   5) Painel web: usa is_platform_admin + admin_* (já integrados nos hooks).
--
-- TESTES DE ACEITAÇÃO
--   • Cadastro cria assinatura trial:
--       -- após novo usuário/empresa:
--       select tenant_id, status, trial_ends_at from public.subscriptions;
--   • Trial expira:
--       update public.subscriptions set trial_ends_at = now() - interval '1 day'
--         where tenant_id = '<tenant>';
--       select public.get_access_status('<tenant>');  -- allowed=false, reason=trial_expired
--   • On/off do dono:
--       select public.admin_set_tenant_access('<tenant>', false); -- bloqueia
--       select public.get_access_status('<tenant>');  -- reason=blocked_by_owner
--       select public.admin_set_tenant_access('<tenant>', true);  -- libera
--   • Isolamento (logado como usuário COMUM, não super-admin):
--       select public.admin_list_tenants_overview();  -- deve LANÇAR 'forbidden'
--       select * from public.payments;                -- deve retornar 0 linhas (RLS)
--
-- SEGURANÇA
--   • Toda decisão de acesso está no servidor (get_access_status) — o app só reflete.
--   • Escrita de subscriptions/payments/app_expenses: só super-admin (RLS + checagem).
--   • tenant_devices nunca é acessado direto pelo cliente (apenas via bind_device).
-- =====================================================================
-- FIM — SCHEMA DE LICENCIAMENTO SAAS
-- =====================================================================
