-- =====================================================================
-- Sir Barbecue — FEATURE: inativação de vínculo produto↔fornecedor.
--
-- Motivo: ao trocar de fornecedor de um produto, o vínculo antigo deixa de
-- valer para custo/margem, mas o dado (fornecedor + preço praticado) é útil
-- para o negócio (histórico + eventual volta ao fornecedor). Em vez de
-- excluir, o vínculo passa a ser INATIVADO: some das telas de uso, some do
-- cálculo do relatório, mas continua guardado. Exclusão de vez fica só para
-- corrigir cadastro errado.
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente. Pré-requisito: product_supplier_price_history.sql já rodado.
-- =====================================================================

begin;

-- 1) Flag de vínculo ativo. Default true: todos os vínculos existentes
--    continuam válidos até serem explicitamente inativados no app.
alter table public.product_suppliers
  add column if not exists is_active boolean not null default true;

-- 2) Refina o trigger de histórico: registrar snapshot em todo INSERT, mas
--    em UPDATE só quando o preço OU o preferido realmente mudarem. Sem isso,
--    inativar (ou qualquer re-sync que reenvia purchase_price/is_preferred
--    inalterados no upsert) geraria um snapshot duplicado no histórico.
create or replace function public.log_product_supplier_price_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.purchase_price is not distinct from old.purchase_price
     and new.is_preferred  is not distinct from old.is_preferred then
    return new; -- nada de fato mudou no preço/preferido → não registra
  end if;
  insert into public.product_supplier_price_history
    (client_id, product_client_id, supplier_client_id, purchase_price, is_preferred, recorded_at)
  values
    (gen_random_uuid(), new.product_client_id, new.supplier_client_id, new.purchase_price, new.is_preferred, now());
  return new;
end;
$$;
-- (o trigger trg_log_price_history criado em product_supplier_price_history.sql
--  continua válido — só a função foi refinada.)

commit;

-- =====================================================================
-- DIAGNÓSTICO DE ÓRFÃS (rode separadamente; opcional)
-- A correção do upsert por chave natural (pushProductSuppliers) impede novas
-- duplicatas para o MESMO par produto/fornecedor. Órfãs só podem existir de
-- TROCAS de fornecedor feitas ANTES desta entrega (remoção que só apagava
-- local). Liste os produtos com mais de um vínculo e decida o que fazer:
-- =====================================================================
-- select product_client_id, count(*) as vinculos,
--        array_agg(supplier_client_id) as fornecedores,
--        array_agg(purchase_price)     as precos,
--        array_agg(is_active)          as ativos
--   from public.product_suppliers
--  group by product_client_id
-- having count(*) > 1;
--
-- -- Inativar um vínculo órfão específico (preferível a excluir — preserva histórico):
-- -- update public.product_suppliers set is_active = false
-- --  where product_client_id = '...' and supplier_client_id = '...';
-- --
-- -- Ou excluir de vez (histórico em product_supplier_price_history é preservado —
-- -- a FK cascateia por products/suppliers, não por product_suppliers):
-- -- delete from public.product_suppliers
-- --  where product_client_id = '...' and supplier_client_id = '...';

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente)
-- =====================================================================
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='product_suppliers' and column_name='is_active';
-- -- Editar um preço → 1 snapshot novo. Inativar (is_active=false) → NENHUM snapshot novo:
-- select * from public.product_supplier_price_history order by recorded_at desc limit 5;
-- =====================================================================
