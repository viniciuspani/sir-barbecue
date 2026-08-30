-- =====================================================================
-- Sir Barbecue — MIGRATION 02 (licenciamento): prorrogação de trial
-- pelo painel web do dono.
--
-- Adiciona duas RPCs admin (is_platform_admin()) que atuam só quando
-- status = 'trial':
--   - admin_extend_tenant_trial(p_tenant_id, p_days default 7)
--       soma p_days dias ao trial_ends_at vigente.
--   - admin_set_tenant_trial_ends_at(p_tenant_id, p_trial_ends_at)
--       define manualmente a data final do trial.
--
-- Pré-requisito: docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql já aplicado
-- (precisa de is_platform_admin() e public.subscriptions).
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente (create or replace function).
-- =====================================================================

begin;

create or replace function public.admin_extend_tenant_trial(p_tenant_id uuid, p_days int default 7)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  update public.subscriptions
     set trial_ends_at = trial_ends_at + make_interval(days => p_days),
         updated_at = now()
   where tenant_id = p_tenant_id
     and status = 'trial';
  if not found then
    raise exception 'assinatura em trial não encontrada para a empresa %', p_tenant_id;
  end if;
end; $$;

create or replace function public.admin_set_tenant_trial_ends_at(p_tenant_id uuid, p_trial_ends_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  update public.subscriptions
     set trial_ends_at = p_trial_ends_at,
         updated_at = now()
   where tenant_id = p_tenant_id
     and status = 'trial';
  if not found then
    raise exception 'assinatura em trial não encontrada para a empresa %', p_tenant_id;
  end if;
end; $$;

grant execute on function public.admin_extend_tenant_trial(uuid, int) to authenticated;
grant execute on function public.admin_set_tenant_trial_ends_at(uuid, timestamptz) to authenticated;

commit;

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO (rode separadamente, fora da transação acima)
-- =====================================================================
-- select tenant_id, status, trial_ends_at from public.subscriptions where tenant_id = '<tenant>';
-- select public.admin_extend_tenant_trial('<tenant>');  -- +7 dias (default)
-- select public.admin_set_tenant_trial_ends_at('<tenant>', now() + interval '15 days');
-- select tenant_id, status, trial_ends_at from public.subscriptions where tenant_id = '<tenant>';
-- -- logado como usuário COMUM (não super-admin), ambas devem LANÇAR 'forbidden':
-- --   select public.admin_extend_tenant_trial('<tenant>');
-- -- para um tenant com status <> 'trial', ambas devem LANÇAR
-- -- 'assinatura em trial não encontrada para a empresa <id>':
-- --   select public.admin_extend_tenant_trial('<tenant-active>');
-- =====================================================================
