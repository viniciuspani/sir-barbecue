-- =====================================================================
-- MIGRATION 12 — create_sale: guarda de assinatura + preço não ditado pelo cliente
-- Correção dos achados A06-01 (mensagem) e A06-02 (Auditoria OWASP 2025).
-- Aplica SOBRE MIGRATION_09_tabs.sql e DEPOIS de MIGRATION_11 (usa tenant_has_access).
-- Idempotente.
--
-- PROBLEMA (A06-02):
--   O comentário da MIGRATION_08 diz "o cliente não dita quanto a venda valeu".
--   Isso era verdade pela metade: o TOTAL era somado no servidor, mas a partir do
--   `unit_price` que veio no JSON do cliente. O servidor nunca confrontava com
--   `products.price` nem com o snapshot da comanda. Qualquer membro — inclusive
--   um employee — registrava a venda com `unit_price: 0.01`, entregava o produto
--   e embolsava o valor cheio. O estoque baixava certo, então a conferência
--   "estoque consumido x faturamento" também não denunciava.
--
-- DECISÕES:
--   • A comparação NÃO pode ser com `products.price` sempre: a comanda guarda um
--     SNAPSHOT de preço de propósito (mudar o preço do produto não pode alterar
--     comanda já aberta — ver MIGRATION_09). Então:
--       - venda rápida (p_tab_client_id null) -> confere com products.price;
--       - fechamento de comanda              -> confere com tab_items.unit_price.
--   • A checagem é escrita como "não existe item SEM correspondência válida", e
--     não como "existe item divergente". A diferença importa: a segunda forma
--     deixaria passar um product_client_id inexistente ou de outra empresa (o
--     join não casaria e nada seria acusado). Desta forma, item sem produto no
--     tenant também é recusado.
--   • Tolerância de R$ 0,01 para arredondamento de ponto flutuante do cliente.
--   • A guarda de assinatura é redundante com a RLS da MIGRATION_11 (a policy já
--     recusaria o INSERT). Ela existe para a mensagem: sem ela o operador receberia
--     "new row violates row-level security policy", que não diz nada a quem está
--     no balcão.
--
-- LIMITE CONHECIDO — o app Android NÃO passa por aqui:
--   O mobile é offline-first e sobe a venda pelo upsert do sync (push direto em
--   `sales`/`sale_items`), não pela RPC. Nesse caminho o `unit_price` continua
--   vindo do aparelho, e não há como validá-lo no servidor sem quebrar o
--   offline: uma venda feita há três dias, sincronizada hoje, legitimamente
--   carrega o preço de três dias atrás. O controle compensatório para esse
--   caminho é a trilha de divergência de preço da MIGRATION_14 (registra, não
--   bloqueia) — que dá ao dono uma lista do que revisar.
-- =====================================================================

create or replace function public.create_sale(
  p_tenant_id        uuid,
  p_client_id        uuid,
  p_payment_method   text,
  p_consumption_mode text,
  -- [{ "product_client_id": uuid, "quantity": numeric, "unit_price": numeric }, ...]
  p_items            jsonb,
  -- Comanda que está sendo paga; null = venda rápida (carrinho).
  p_tab_client_id    uuid default null
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
  -- Vem ANTES das guardas: um retry de venda já gravada não pode falhar só porque
  -- a assinatura venceu no intervalo entre a primeira chamada e o retry.
  if exists (select 1 from public.sales where client_id = p_client_id) then
    return p_client_id;
  end if;

  -- Guarda de assinatura (A06-01). A RLS já barraria; isto é pela mensagem.
  if not public.tenant_has_access(p_tenant_id) then
    raise exception 'assinatura inativa: regularize para continuar vendendo';
  end if;

  -- Guarda de preço (A06-02).
  if p_tab_client_id is null then
    -- Venda rápida: o preço tem de bater com o cadastro do produto, e o produto
    -- tem de ser DESTA empresa.
    if exists (
      select 1
        from jsonb_array_elements(p_items) as i
       where not exists (
         select 1
           from public.products pr
          where pr.client_id = (i->>'product_client_id')::uuid
            and pr.tenant_id = p_tenant_id
            and abs((i->>'unit_price')::numeric - pr.price) <= 0.01
       )
    ) then
      raise exception 'preço divergente do cadastro do produto';
    end if;
  else
    -- Comanda: o preço tem de bater com o snapshot gravado quando o item entrou.
    if exists (
      select 1
        from jsonb_array_elements(p_items) as i
       where not exists (
         select 1
           from public.tab_items ti
          where ti.tab_client_id = p_tab_client_id
            and ti.product_client_id = (i->>'product_client_id')::uuid
            and abs((i->>'unit_price')::numeric - ti.unit_price) <= 0.01
       )
    ) then
      raise exception 'preço divergente da comanda';
    end if;
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

  -- Fechamento da comanda na MESMA transação da venda.
  if p_tab_client_id is not null then
    update public.tabs
       set status = 'closed', closed_at = now(), sale_client_id = p_client_id, updated_at = now()
     where client_id = p_tab_client_id
       and tenant_id = p_tenant_id
       and status = 'open';
    -- 0 linhas = comanda inexistente, de outra empresa ou já fechada por outro
    -- aparelho. Abortar evita cobrar duas vezes a mesma comanda.
    if not found then
      raise exception 'comanda não está aberta (já foi fechada em outro aparelho?)';
    end if;
  end if;

  return p_client_id;
end;
$$;

comment on function public.create_sale(uuid, uuid, text, text, jsonb, uuid) is
  'Registra venda + itens + baixa de estoque (e fecha a comanda, se informada) em UMA transação. Idempotente por client_id; total calculado no servidor; exige assinatura ativa e preço conferido contra o cadastro (venda rápida) ou a comanda.';

revoke all on function public.create_sale(uuid, uuid, text, text, jsonb, uuid) from public;
grant execute on function public.create_sale(uuid, uuid, text, text, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Verificação
-- ---------------------------------------------------------------------
-- Venda rápida com preço adulterado deve falhar com 'preço divergente do cadastro do produto':
--   select public.create_sale(
--     '<tenant>'::uuid, gen_random_uuid(), 'cash', 'on_site',
--     '[{"product_client_id":"<produto>","quantity":1,"unit_price":0.01}]'::jsonb);
--
-- A mesma chamada com o preço correto do cadastro deve gravar normalmente.
