-- =====================================================================
-- Fix: baixa/entrada de estoque devem respeitar a RLS por papel (RBAC)
-- =====================================================================
-- Contexto: as triggers de estoque rodam COM O PAPEL de quem disparou o DML.
-- Sem SECURITY DEFINER, quando um FUNCIONÁRIO (employee, sem write em
-- stock_items) registra uma venda, o UPDATE dentro de deduct_stock_on_sale
-- cai na RLS de escrita (stock_items_write = owner/manager). No PostgreSQL,
-- uma linha que não passa no USING da RLS é SILENCIOSAMENTE filtrada: o UPDATE
-- afeta 0 linhas e NÃO lança erro. Efeito: a venda grava normalmente, mas o
-- estoque NÃO é deduzido no servidor; no pull server-wins seguinte a quantidade
-- antiga (maior) volta e sobrescreve a baixa local → o estoque INFLA a cada
-- venda de funcionário, sem erro visível.
--
-- Correção: tornar as triggers SECURITY DEFINER (mesmo padrão já usado no
-- trigger de histórico de preço), para que a manutenção do dado derivado
-- (stock_items.quantity) atravesse a RLS. É seguro: cada função só mexe no
-- produto do item recém-inserido, e o INSERT em sale_items/stock_entries já é
-- gatilhado pela RLS (só membro do tenant insere).
--
-- Idempotente. Não precisa recriar as triggers: CREATE OR REPLACE FUNCTION
-- mantém o vínculo com os triggers existentes.
-- =====================================================================

-- RF-10: dedução automática de estoque ao inserir item de venda
create or replace function public.deduct_stock_on_sale()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.stock_items
    set quantity = quantity - new.quantity, updated_at = now()
    where product_client_id = new.product_client_id;
  return new;
end; $$;

-- RF-09: incremento de estoque ao registrar entrada.
-- Hoje entradas só são criadas por owner/manager (que passam na RLS), mas
-- tornamos SECURITY DEFINER por simetria e robustez (evita a mesma pegadinha
-- caso a política de escrita de entradas mude no futuro).
create or replace function public.increment_stock_on_entry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.stock_items (tenant_id, client_id, product_client_id, user_id, quantity)
    values (new.tenant_id, gen_random_uuid(), new.product_client_id, new.user_id, new.quantity)
  on conflict (product_client_id)
    do update set quantity = public.stock_items.quantity + new.quantity, updated_at = now();
  return new;
end; $$;
