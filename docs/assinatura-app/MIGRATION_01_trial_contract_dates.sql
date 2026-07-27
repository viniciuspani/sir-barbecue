-- =====================================================================
-- Sir Barbecue — MIGRATION 01 (licenciamento): datas de início do trial
-- e início do relacionamento pago, para alimentar o painel web do dono.
--
-- Adiciona a public.subscriptions:
--   - trial_started_at    : quando o trial começou (backfill = created_at,
--                            já que a assinatura sempre nasce em trial).
--   - contract_started_at : quando a empresa virou cliente pago (1ª vez que
--                            status virou 'active'). Setado automaticamente
--                            por trigger dali em diante; back fill manual
--                            abaixo para quem já está 'active' hoje.
--
-- Pré-requisito: docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql já aplicado.
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente (add column if not exists + create or replace).
-- =====================================================================

begin;

-- 1) Novas colunas.
alter table public.subscriptions
  add column if not exists trial_started_at    timestamptz,
  add column if not exists contract_started_at timestamptz;

-- 2) Backfill trial_started_at: a assinatura sempre nasce em trial
--    (seed_tenant_subscription), então created_at é o início real do trial.
update public.subscriptions
   set trial_started_at = created_at
 where trial_started_at is null;

-- 3) Backfill contract_started_at para quem já está 'active' hoje e não tem
--    a data registrada. Sem histórico exato de quando converteu, usa
--    trial_ends_at (fim do trial) como melhor estimativa disponível.
--    Proposital: só toca status = 'active'. Quem está 'trial' — em aberto e
--    ainda dentro da validade, OU já vencido (trial_ends_at no passado, mas
--    o status em si só muda quando o dono ativa manualmente) — fica de fora
--    e continua com contract_started_at = null, porque ainda não virou
--    cliente pago. Não recebe backfill nem é afetado por este UPDATE.
update public.subscriptions
   set contract_started_at = coalesce(trial_ends_at, updated_at)
 where status = 'active'
   and contract_started_at is null;

-- 4) seed_tenant_subscription: passa a gravar trial_started_at = now().
create or replace function public.seed_tenant_subscription()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions (tenant_id, status, trial_started_at, trial_ends_at)
    values (new.id, 'trial', now(), now() + interval '7 days')
  on conflict (tenant_id) do nothing;
  return new;
end; $$;

-- 5) Trigger: registra contract_started_at na 1ª vez que o status vira
--    'active' (trial convertendo em cliente pago). Não é sobrescrito depois.
create or replace function public.set_contract_started_at()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'active' and old.status is distinct from 'active'
     and new.contract_started_at is null then
    new.contract_started_at := now();
  end if;
  return new;
end; $$;
drop trigger if exists trg_subscriptions_contract_started_at on public.subscriptions;
create trigger trg_subscriptions_contract_started_at
  before update on public.subscriptions
  for each row execute function public.set_contract_started_at();

-- 6) admin_list_tenants_overview: acrescenta trialStartedAt/contractStartedAt.
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
        'lastPaymentAt', (select max(p.paid_at) from public.payments p where p.tenant_id = t.id)
      ) as row_obj
      from public.tenants t
      join public.subscriptions s on s.tenant_id = t.id
    ) q
  ), '[]'::jsonb);
end; $$;

-- 7) admin_tenant_detail: idem, no detalhe do cliente.
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

commit;

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO (rode separadamente, fora da transação acima)
-- =====================================================================
-- select tenant_id, status, trial_started_at, trial_ends_at, contract_started_at
--   from public.subscriptions;
-- select public.admin_list_tenants_overview();  -- logado como dono: deve trazer os 2 campos novos
-- -- simula conversão trial → active e confirma que contract_started_at é preenchido:
-- --   update public.subscriptions set status = 'active' where tenant_id = '<id>';
-- --   select contract_started_at from public.subscriptions where tenant_id = '<id>';
-- =====================================================================
