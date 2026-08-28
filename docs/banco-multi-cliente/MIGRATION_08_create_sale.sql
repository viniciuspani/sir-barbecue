-- =====================================================================
-- MIGRATION 08 — RPC create_sale (venda transacional para o cliente WEB)
-- Aplica SOBRE SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql (+ MIGRATION_03).
-- Idempotente (create or replace function).
--
-- MOTIVAÇÃO:
--   O app mobile é offline-first: ele grava venda + itens + baixa de estoque
--   numa transação do SQLite local e depois sincroniza. O app WEB (PWA) não tem
--   banco local — ele escreve direto no Postgres. Se fizesse isso com inserts
--   soltos do cliente (um INSERT em sales, depois N em sale_items), uma queda de
--   rede no meio deixaria venda sem itens ou itens sem baixa de estoque: o
--   caixa acha que vendeu e o estoque diz outra coisa.
--
--   Esta função põe tudo numa única transação do servidor. Uma função plpgsql
--   roda como uma transação: se QUALQUER passo falhar — inclusive o CHECK
--   quantity >= 0 de stock_items, disparado pela trigger deduct_stock_on_sale —
--   nada é gravado. Não existe venda pela metade.
--
-- DECISÕES:
--   • SECURITY INVOKER (e não DEFINER): os INSERTs passam pela RLS do próprio
--     usuário. A política tenant_all de sales já exige que o tenant seja um dos
--     do usuário, então NÃO é preciso revalidar o vínculo aqui — e não abrimos
--     um caminho privilegiado que ignore a RLS.
--     A baixa de estoque continua funcionando para o FUNCIONÁRIO porque a
--     trigger deduct_stock_on_sale é SECURITY DEFINER (ver MIGRATION_03).
--   • O TOTAL é calculado no servidor a partir dos itens. O cliente não dita
--     quanto a venda valeu — some a diferença entre o que foi cobrado e o que
--     foi registrado.
--   • IDEMPOTÊNCIA por client_id: no PDV, um toque duplo ou um retry de rede não
--     pode virar duas vendas. Repetir a chamada com o mesmo client_id devolve a
--     venda existente sem gravar nada de novo.
-- =====================================================================

create or replace function public.create_sale(
  p_tenant_id        uuid,
  p_client_id        uuid,
  p_payment_method   text,
  p_consumption_mode text,
  -- [{ "product_client_id": uuid, "quantity": numeric, "unit_price": numeric }, ...]
  p_items            jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total numeric(12,2);
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'venda sem itens';
  end if;

  -- Idempotência: mesma venda enviada duas vezes (toque duplo, retry) não duplica.
  if exists (select 1 from public.sales where client_id = p_client_id) then
    return p_client_id;
  end if;

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_price')::numeric), 0)
    into v_total
    from jsonb_array_elements(p_items) as i;

  -- synced_at = now(): esta venda NASCEU no servidor (o NULL da coluna significa
  -- "registrada offline e ainda não sincronizada", que é o caso do mobile).
  insert into public.sales (
    tenant_id, client_id, total_amount, payment_method, consumption_mode, sale_date, synced_at
  )
  values (
    p_tenant_id, p_client_id, v_total, p_payment_method, p_consumption_mode, now(), now()
  );

  -- Cada INSERT aqui dispara deduct_stock_on_sale. Estoque insuficiente viola o
  -- CHECK quantity >= 0 e derruba a transação inteira — a venda não acontece.
  insert into public.sale_items (client_id, sale_client_id, product_client_id, quantity, unit_price)
  select
    gen_random_uuid(),
    p_client_id,
    (i->>'product_client_id')::uuid,
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric
  from jsonb_array_elements(p_items) as i;

  return p_client_id;
end;
$$;

comment on function public.create_sale(uuid, uuid, text, text, jsonb) is
  'Registra venda + itens + baixa de estoque em UMA transação. Usada pelo app web (sem banco local). Idempotente por client_id; total calculado no servidor.';

revoke all on function public.create_sale(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.create_sale(uuid, uuid, text, text, jsonb) to authenticated;
