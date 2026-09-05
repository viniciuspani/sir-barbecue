-- =====================================================================
-- Sir Barbecue — MIGRATION 04 (licenciamento): e-mail do dono da empresa
-- no detalhe do cliente (painel web do dono).
--
-- admin_tenant_detail() ganha o campo 'email' — não existe coluna de e-mail
-- em tenants/subscriptions, vem de auth.users.email via tenants.owner_user_id
-- (mesmo padrão de join já usado em admin_list_error_logs, ver
-- docs/banco-multi-cliente/MIGRATION_05_error_logs.sql).
--
-- Pré-requisito: docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql já aplicado.
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente (create or replace function).
-- =====================================================================

begin;

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
    ), '[]'::jsonb)
  ) into v_result
  from public.tenants t
  join public.subscriptions s on s.tenant_id = t.id
  left join auth.users u on u.id = t.owner_user_id
  where t.id = p_tenant_id;

  return v_result; -- null se a empresa não existir
end; $$;

commit;

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO
-- =====================================================================
-- select public.admin_tenant_detail('<tenant>');  -- deve trazer "email" preenchido
-- =====================================================================
