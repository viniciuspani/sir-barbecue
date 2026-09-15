-- =====================================================================
-- MIGRATION 19 — Exclusão de empresa: ordem EXPLÍCITA (corrige a 18)
-- Aplica SOBRE a MIGRATION_18. Idempotente (create or replace).
--
-- POR QUE ESTA MIGRAÇÃO EXISTE — o erro da 18:
--   A MIGRATION_18 trocou seis FKs de RESTRICT para NO ACTION apostando que,
--   com NO ACTION, a verificação seria adiada para o FIM DA INSTRUÇÃO — quando
--   `sale_items` já teria sido removido pelo cascade `tenants -> sales`.
--   A troca foi aplicada (confirmado no catálogo: confdeltype = 'a'), e a
--   exclusão FALHOU EXATAMENTE IGUAL:
--
--     23503: update or delete on table "products" violates foreign key
--     constraint "sale_items_product_client_id_fkey" on table "sale_items"
--
--   A premissa estava errada. A verificação de integridade é enfileirada como
--   trigger AFTER no momento em que a linha de `products` é apagada, e a ordem
--   em que essa fila é processada — entre os vários cascades que `tenants`
--   dispara ao mesmo tempo — NÃO é determinística. O check de `products` rodou
--   antes de o cascade de `sales` chegar em `sale_items`.
--
--   NO ACTION só adia de verdade quando a constraint é declarada DEFERRABLE.
--   Sem isso, a diferença para RESTRICT é sutil demais para se apoiar nela.
--
-- A CORREÇÃO: não depender de ordem implícita nenhuma.
--   `delete_tenant_cascade` passa a apagar as filhas EXPLICITAMENTE, de baixo
--   para cima, antes de chegar na empresa. Determinístico, legível, e imune a
--   como o Postgres decide processar a fila de triggers.
--
-- E A MIGRATION_18? Pode ficar como está. As seis FKs em NO ACTION continuam
--   proibindo exatamente o que proibiam antes (NO ACTION é o padrão do Postgres
--   para FK); elas apenas deixaram de ser necessárias. Reverter só geraria
--   churn sem ganho.
-- =====================================================================

create or replace function public.delete_tenant_cascade(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ORDEM: das folhas para a raiz. Cada bloco remove tudo que aponta para o
  -- bloco seguinte, de modo que quando `products`, `suppliers` e `categories`
  -- forem apagados já não exista nada os referenciando.

  -- 1) Itens de venda e de comanda. Apontam para `products` e são o que barrava
  --    a exclusão. Cascateariam de sales/tabs, mas aqui a ordem é garantida.
  delete from public.sale_items si
   using public.sales s
   where s.client_id = si.sale_client_id
     and s.tenant_id = p_tenant_id;

  delete from public.tab_items ti
   using public.tabs t
   where t.client_id = ti.tab_client_id
     and t.tenant_id = p_tenant_id;

  -- 2) Filhas diretas de `products` / `suppliers`.
  delete from public.product_day_visibility pdv
   using public.products pr
   where pr.client_id = pdv.product_client_id
     and pr.tenant_id = p_tenant_id;

  delete from public.product_supplier_price_history h
   using public.products pr
   where pr.client_id = h.product_client_id
     and pr.tenant_id = p_tenant_id;

  -- product_suppliers: a única tabela do grafo SEM caminho de cascade a partir
  -- de `tenants` (não tem tenant_id). Os dois lados por robustez.
  delete from public.product_suppliers ps
   using public.products pr
   where pr.client_id = ps.product_client_id
     and pr.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.suppliers su
   where su.client_id = ps.supplier_client_id
     and su.tenant_id = p_tenant_id;

  -- 3) Tabelas com tenant_id que apontam para products/suppliers.
  delete from public.stock_items   where tenant_id = p_tenant_id;
  delete from public.stock_entries where tenant_id = p_tenant_id;

  -- 4) Vendas e comandas (já sem itens).
  delete from public.sales where tenant_id = p_tenant_id;
  delete from public.tabs  where tenant_id = p_tenant_id;

  -- 5) Catálogo. `products` referencia `categories`, então categorias por último.
  delete from public.products   where tenant_id = p_tenant_id;
  delete from public.suppliers  where tenant_id = p_tenant_id;
  delete from public.categories where tenant_id = p_tenant_id;

  -- 6) O que resta (reports, sync_checkpoints, tenant_members, tenant_invites,
  --    error_logs, subscriptions, tenant_devices, payments) tem tenant_id com
  --    ON DELETE CASCADE e nada aponta para ele: sai junto com a empresa.
  delete from public.tenants where id = p_tenant_id;
end;
$$;

comment on function public.delete_tenant_cascade(uuid) is
  'Exclui a empresa e TODOS os seus dados, numa transação, apagando as tabelas filhas em ordem EXPLÍCITA (não depende da ordem de cascade do Postgres). Uso exclusivo do servidor (Edge Function delete-account).';

revoke execute on function public.delete_tenant_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_tenant_cascade(uuid) to service_role;

-- =====================================================================
-- VERIFICAÇÃO — fazer em empresa DESCARTÁVEL, com venda, comanda e estoque
-- =====================================================================
-- Antes (todos > 0 no que a empresa tiver):
--   select
--     (select count(*) from public.products   where tenant_id = '<t>') as produtos,
--     (select count(*) from public.sales      where tenant_id = '<t>') as vendas,
--     (select count(*) from public.stock_items where tenant_id = '<t>') as estoque;
--
--   select public.delete_tenant_cascade('<t>');
--
-- Depois — todos devem voltar ZERO:
--   select
--     (select count(*) from public.tenants    where id = '<t>')        as empresa,
--     (select count(*) from public.products   where tenant_id = '<t>') as produtos,
--     (select count(*) from public.sales      where tenant_id = '<t>') as vendas,
--     (select count(*) from public.sale_items si join public.sales s
--        on s.client_id = si.sale_client_id where s.tenant_id = '<t>') as itens_venda;
--
-- A regra de negócio segue intacta — isto deve CONTINUAR falhando:
--   delete from public.products where client_id = '<produto com venda>';
-- =====================================================================
