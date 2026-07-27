-- =====================================================================
-- Sir Barbecue — MIGRAÇÃO: remove a coluna unit_cost de stock_entries.
--
-- Motivo: o custo do produto passou a ser centralizado no cadastro do
-- fornecedor (public.product_suppliers.purchase_price), que é a única
-- fonte usada pelo relatório (supabase/functions/generate-report) para
-- calcular lucro/margem. O campo "Custo unitário" da tela de entrada de
-- estoque foi removido do app — dados aqui ficariam órfãos e
-- confundiriam o usuário, então limpamos antes de derrubar a coluna.
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente: pode rodar mais de uma vez sem erro.
-- =====================================================================

begin;

-- 1) Zera os dados existentes na coluna (auditoria explícita antes do drop —
--    tecnicamente redundante já que o DROP COLUMN abaixo apaga os dados de
--    qualquer forma, mas deixa o passo de exclusão de dados explícito).
update public.stock_entries
   set unit_cost = null
 where unit_cost is not null;

-- 2) Remove a coluna da tabela.
alter table public.stock_entries
  drop column if exists unit_cost;

commit;

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO (rode separadamente, fora da transação acima)
-- =====================================================================
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'stock_entries';
-- -- não deve mais listar "unit_cost"
-- =====================================================================
