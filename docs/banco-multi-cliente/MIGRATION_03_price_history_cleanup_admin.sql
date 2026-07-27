-- =====================================================================
-- Sir Barbecue — MIGRATION 03: limpeza do histórico de preço configurável
-- pelo painel do dono (em vez de só via SQL Editor/pg_cron manual).
--
-- Pré-requisitos: SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql,
-- docs/scripts/product_supplier_price_history.sql (cria a tabela e a
-- função cleanup_product_supplier_price_history) e
-- docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql (is_platform_admin())
-- já aplicados.
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente (create/replace + drop-if-exists antes de recriar).
-- =====================================================================

begin;

-- 1) Config global da plataforma (singleton — 1 linha só, id fixo).
--    Começa com o mesmo default (6 meses) que a função já usava.
create table if not exists public.platform_settings (
  id                              boolean primary key default true check (id),
  price_history_retention_months integer not null default 6 check (price_history_retention_months > 0),
  updated_at                      timestamptz not null default now()
);

insert into public.platform_settings (id) values (true)
on conflict (id) do nothing;

drop trigger if exists trg_platform_settings_updated_at on public.platform_settings;
create trigger trg_platform_settings_updated_at
  before update on public.platform_settings
  for each row execute function public.update_updated_at_column();

alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_admin_all on public.platform_settings;
create policy platform_settings_admin_all on public.platform_settings for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- 2) cleanup_product_supplier_price_history agora retorna a quantidade de
--    linhas apagadas (era `void`) para o painel poder mostrar o resultado.
--    Precisa DROP porque mudar o tipo de retorno não é permitido via
--    CREATE OR REPLACE.
drop function if exists public.cleanup_product_supplier_price_history(integer);

create function public.cleanup_product_supplier_price_history(
  p_retention_months integer default 6
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.product_supplier_price_history
   where recorded_at < now() - (p_retention_months || ' months')::interval;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.cleanup_product_supplier_price_history(integer)
  from public, authenticated, anon;

-- 3) Wrapper sem parâmetro, lê a retenção configurada em platform_settings.
--    É este que o pg_cron agenda (a retenção muda sem precisar re-agendar).
create or replace function public.cleanup_product_supplier_price_history_scheduled()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_months integer;
begin
  select price_history_retention_months into v_months from public.platform_settings where id = true;
  return public.cleanup_product_supplier_price_history(coalesce(v_months, 6));
end;
$$;

revoke execute on function public.cleanup_product_supplier_price_history_scheduled()
  from public, authenticated, anon;

-- 4) RPCs de administração (painel do dono) — mesmo padrão de admin_* do
--    licenciamento: valida is_platform_admin() e retorna camelCase.

create or replace function public.admin_get_price_history_retention()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_months integer;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  select price_history_retention_months into v_months from public.platform_settings where id = true;
  return jsonb_build_object('retentionMonths', v_months);
end; $$;

create or replace function public.admin_set_price_history_retention(p_months integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  if p_months is null or p_months <= 0 then
    raise exception 'retenção inválida: informe um número de meses maior que zero';
  end if;

  update public.platform_settings set price_history_retention_months = p_months where id = true;

  return jsonb_build_object('retentionMonths', p_months);
end; $$;

-- Ação manual "rodar limpeza agora". Sem p_months usa a retenção salva;
-- com p_months roda avulso com esse valor sem alterar a config salva.
create or replace function public.admin_run_price_history_cleanup(p_months integer default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_months  integer;
  v_deleted integer;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  if p_months is not null and p_months <= 0 then
    raise exception 'retenção inválida: informe um número de meses maior que zero';
  end if;

  if p_months is null then
    select price_history_retention_months into v_months from public.platform_settings where id = true;
    v_months := coalesce(v_months, 6);
  else
    v_months := p_months;
  end if;

  v_deleted := public.cleanup_product_supplier_price_history(v_months);

  return jsonb_build_object('retentionMonths', v_months, 'deletedCount', v_deleted);
end; $$;

grant execute on function public.admin_get_price_history_retention() to authenticated;
grant execute on function public.admin_set_price_history_retention(integer) to authenticated;
grant execute on function public.admin_run_price_history_cleanup(integer) to authenticated;

commit;

-- =====================================================================
-- AGENDAMENTO (pg_cron) — OPCIONAL, requer a extensão pg_cron habilitada
-- em Supabase Dashboard → Database → Extensions ANTES de rodar. Substitui
-- o snippet comentado em docs/scripts/product_supplier_price_history.sql
-- (que chamava a função com um valor fixo) — este usa o wrapper, então a
-- retenção configurada pelo painel vale automaticamente sem re-agendar.
-- Roda às 03h do dia 1, a cada 6 meses.
-- =====================================================================
-- select cron.schedule(
--   'cleanup-product-supplier-price-history',
--   '0 3 1 */6 *',
--   $$select public.cleanup_product_supplier_price_history_scheduled();$$
-- );

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO (rode separadamente, fora da transação acima)
-- =====================================================================
-- select * from public.platform_settings;
-- select public.admin_get_price_history_retention();       -- logado como dono
-- select public.admin_set_price_history_retention(3);       -- muda para 3 meses
-- select public.admin_run_price_history_cleanup();          -- roda com o valor salvo
-- select public.admin_run_price_history_cleanup(0);         -- roda avulso (NÃO em produção sem necessidade)
-- -- isolamento (logado como usuário comum, não super-admin): deve lançar 'forbidden'
-- select public.admin_get_price_history_retention();
-- =====================================================================
