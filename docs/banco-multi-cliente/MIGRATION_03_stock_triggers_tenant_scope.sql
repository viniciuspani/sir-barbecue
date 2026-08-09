-- =====================================================================
-- MIGRATION 03 — Escopo de tenant nas triggers de estoque (SECURITY DEFINER)
-- Aplica SOBRE SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql (+ fix_stock_triggers_security_definer.sql).
-- Idempotente (create or replace function — mantém os triggers existentes).
--
-- MOTIVAÇÃO (correção MÉDIA — integridade cross-tenant):
--   deduct_stock_on_sale/increment_stock_on_entry rodam como SECURITY DEFINER
--   (bypassam a RLS) e atualizavam stock_items SÓ por product_client_id, sem
--   filtrar tenant. Como product_client_id é único GLOBAL (não por empresa) e a
--   RLS de sale_items valida apenas a venda-pai (não o produto do item), um
--   usuário do tenant A podia inserir um item de venda referenciando o
--   product_client_id de um produto do tenant B e assim mexer no estoque de B.
--
--   Correção: derivar o tenant da venda/entrada, RECUSAR itens que referenciem
--   produto de outra empresa e ESCOPAR o UPDATE de stock_items pelo tenant.
-- =====================================================================

-- RF-10: dedução de estoque ao inserir item de venda — agora com escopo de tenant.
create or replace function public.deduct_stock_on_sale()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
begin
  -- tenant da venda-pai (fonte da verdade do escopo).
  select s.tenant_id into v_tenant_id
    from public.sales s
    where s.client_id = new.sale_client_id;

  if v_tenant_id is null then
    raise exception 'venda inexistente para o item (sale_client_id=%)', new.sale_client_id;
  end if;

  -- o produto do item PRECISA pertencer ao mesmo tenant da venda (anti cross-tenant).
  if not exists (
    select 1 from public.products p
    where p.client_id = new.product_client_id and p.tenant_id = v_tenant_id
  ) then
    raise exception 'produto de outra empresa no item de venda (cross-tenant)';
  end if;

  update public.stock_items
    set quantity = quantity - new.quantity, updated_at = now()
    where product_client_id = new.product_client_id
      and tenant_id = v_tenant_id;
  return new;
end; $$;

-- RF-09: incremento de estoque ao registrar entrada — herda o tenant da entrada e valida o produto.
create or replace function public.increment_stock_on_entry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- o produto da entrada PRECISA pertencer ao tenant da entrada (anti cross-tenant).
  if not exists (
    select 1 from public.products p
    where p.client_id = new.product_client_id and p.tenant_id = new.tenant_id
  ) then
    raise exception 'produto de outra empresa na entrada de estoque (cross-tenant)';
  end if;

  insert into public.stock_items (tenant_id, client_id, product_client_id, user_id, quantity)
    values (new.tenant_id, gen_random_uuid(), new.product_client_id, new.user_id, new.quantity)
  on conflict (product_client_id)
    do update set quantity = public.stock_items.quantity + new.quantity, updated_at = now()
    where public.stock_items.tenant_id = new.tenant_id; -- só atualiza a linha do próprio tenant
  return new;
end; $$;
