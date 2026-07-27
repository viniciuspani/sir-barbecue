-- =====================================================================
-- Sir Barbecue — FEATURE: histórico de preço de compra por fornecedor.
--
-- Motivo: public.product_suppliers guarda só o preço VIGENTE por par
-- (produto, fornecedor) — unique (product_client_id, supplier_client_id).
-- Não existe série temporal. Este script cria uma tabela append-only que
-- registra cada INSERT/UPDATE de preço em product_suppliers via trigger,
-- para a tela do app "Histórico de preço de compra" (RF de custo/margem).
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente (create/replace + drop-if-exists antes de recriar).
-- =====================================================================

begin;

-- 1) Tabela de histórico (filha normalizada, sem tenant_id direto — mesmo
--    padrão de product_suppliers: isolamento via EXISTS no produto pai).
create table if not exists public.product_supplier_price_history (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null unique,
  product_client_id  uuid not null references public.products (client_id) on delete cascade,
  supplier_client_id uuid not null references public.suppliers (client_id) on delete cascade,
  purchase_price     numeric(10,2) not null check (purchase_price >= 0),
  is_preferred       boolean not null default false,
  recorded_at        timestamptz not null default now()
);

-- on delete cascade (não restrict como em product_suppliers): histórico deve
-- sobreviver à remoção do vínculo atual, mas não a um produto/fornecedor
-- apagado de vez. Sem updated_at — é append-only, nunca é atualizada.

create index if not exists idx_product_supplier_price_history_product
  on public.product_supplier_price_history (product_client_id, recorded_at desc);

-- 2) Trigger de captura: registra snapshot a cada INSERT (novo vínculo) ou
--    UPDATE de preço/preferido (edição direta) em product_suppliers.
create or replace function public.log_product_supplier_price_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.product_supplier_price_history
    (client_id, product_client_id, supplier_client_id, purchase_price, is_preferred, recorded_at)
  values
    (gen_random_uuid(), new.product_client_id, new.supplier_client_id, new.purchase_price, new.is_preferred, now());
  return new;
end;
$$;

drop trigger if exists trg_log_price_history on public.product_suppliers;
create trigger trg_log_price_history
  after insert or update of purchase_price, is_preferred on public.product_suppliers
  for each row execute function public.log_product_supplier_price_history();

-- 3) Limpeza parametrizável (retenção em meses, default 6). SECURITY DEFINER
--    porque precisa limpar histórico de TODOS os tenants — é rotina de
--    manutenção, não uma operação do usuário — então a execução pública é
--    revogada (só roda via SQL Editor/cron com privilégio de owner).
create or replace function public.cleanup_product_supplier_price_history(
  p_retention_months integer default 6
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.product_supplier_price_history
   where recorded_at < now() - (p_retention_months || ' months')::interval;
end;
$$;

revoke execute on function public.cleanup_product_supplier_price_history(integer)
  from public, authenticated, anon;

-- 4) RLS — somente leitura para o app (só o trigger, com SECURITY DEFINER,
--    escreve). Mesma regra EXISTS-no-pai usada em product_suppliers.
alter table public.product_supplier_price_history enable row level security;

drop policy if exists tenant_select on public.product_supplier_price_history;
create policy tenant_select on public.product_supplier_price_history
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and p.tenant_id in (select public.user_tenant_ids())));

commit;

-- =====================================================================
-- AGENDAMENTO (pg_cron) — SUPERADO por
-- docs/banco-multi-cliente/MIGRATION_03_price_history_cleanup_admin.sql,
-- que troca a retenção fixa (6) por uma config editável pelo painel do
-- dono (platform_settings) e agenda via um wrapper que lê essa config.
-- Rode a migration 03 em vez do snippet abaixo.
-- =====================================================================
-- select cron.schedule(
--   'cleanup-product-supplier-price-history',
--   '0 3 1 */6 *',
--   $$select public.cleanup_product_supplier_price_history(6);$$
-- );

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO (rode separadamente, fora da transação acima)
-- =====================================================================
-- -- edite um preço em product_suppliers e confirme que aparece aqui:
-- select * from public.product_supplier_price_history order by recorded_at desc limit 5;
-- -- teste de sanidade do parâmetro (NÃO rode em produção sem necessidade —
-- -- apaga tudo que for mais antigo que "agora"):
-- -- select public.cleanup_product_supplier_price_history(0);
-- =====================================================================
