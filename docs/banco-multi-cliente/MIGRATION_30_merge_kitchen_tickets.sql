-- =====================================================================
-- MIGRATION 30 — Um só ticket de cozinha por comanda enquanto ativo
-- Aplica SOBRE MIGRATION_29_kitchen_tickets.sql (create_sale vigente).
-- Idempotente.
--
-- MOTIVAÇÃO:
--   Um cliente pede, paga (pré-pago) e vai para a churrasqueira. Antes de
--   retirar, ele decide pedir mais e paga de novo — a MIGRATION_29 criava um
--   SEGUNDO ticket na fila para a mesma comanda, em vez de juntar no que já
--   existia. O negócio quer só UM cartão por comanda enquanto ela ainda tem
--   pedido em aberto na cozinha: o pedido novo entra no ticket existente.
--
-- DECISÕES:
--   • "Ticket ativo" = status 'pending' ou 'ready' (só 'delivered' encerra o
--     ciclo). Encontrando um ativo para a comanda, o pagamento novo GRUDA
--     nele (concatena os itens); sem um ativo, nasce ticket novo — mesma regra
--     de sempre.
--   • Ticket que estava 'ready' e recebe item novo volta para 'pending': não
--     dá para considerar pronto um pedido que acabou de ganhar item que ainda
--     não foi preparado. `ready_at` zera junto, para não sobrar um "ficou
--     pronto às HH:MM" que não é mais verdade.
--   • kitchen_tickets.sale_client_id deixa de ser UNIQUE: um ticket que recebe
--     itens de pagamentos (vendas) diferentes ao longo do tempo não pode mais
--     estar amarrado 1:1 a uma única venda. A coluna continua guardando a
--     venda que originou o ticket (a primeira), só não é mais chave única —
--     rastreabilidade completa de "quais vendas alimentaram este ticket"
--     seguiria por sales.tab_client_id, se algum dia for necessária.
--   • A trava (FOR UPDATE na comanda) que já existia protege este merge da
--     mesma forma que protegia o decremento de tab_items: dois pagamentos
--     concorrentes da mesma comanda continuam serializados.
-- =====================================================================

alter table public.kitchen_tickets
  drop constraint if exists kitchen_tickets_sale_client_id_key;

create or replace function public.create_sale(
  p_tenant_id        uuid,
  p_client_id        uuid,
  p_payments         jsonb,
  p_consumption_mode text,
  p_items            jsonb,
  p_tab_client_id    uuid default null,
  p_queue            boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total            numeric(12,2);
  v_payments_sum     numeric(12,2);
  v_payment_method   varchar(20);
  v_payments_count   integer;
  v_distinct_methods integer;
  v_is_full_payment  boolean;
  v_customer_name    varchar(120);
  v_ticket_items     jsonb;
  v_ticket_id        uuid;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'venda sem itens';
  end if;

  if exists (select 1 from public.sales where client_id = p_client_id) then
    return p_client_id;
  end if;

  if exists (select 1 from public.account_deletion_requests r
              where r.tenant_id = p_tenant_id and r.status = 'pending') then
    raise exception 'exclusão de conta agendada: cancele a solicitação para voltar a vender';
  end if;

  if not public.tenant_has_access(p_tenant_id) then
    raise exception 'assinatura inativa: regularize para continuar vendendo';
  end if;

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) = 0 then
    raise exception 'venda sem forma de pagamento';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_payments) as pmt
     where (pmt->>'method') not in ('cash','pix','credit_card','debit_card')
        or coalesce((pmt->>'amount')::numeric, 0) <= 0
  ) then
    raise exception 'forma de pagamento inválida';
  end if;

  select count(*), count(distinct pmt->>'method')
    into v_payments_count, v_distinct_methods
    from jsonb_array_elements(p_payments) as pmt;
  if v_payments_count <> v_distinct_methods then
    raise exception 'forma de pagamento repetida';
  end if;

  if p_tab_client_id is null then
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
    perform 1 from public.tabs
     where client_id = p_tab_client_id
       and tenant_id = p_tenant_id
       and status = 'open'
     for update;
    if not found then
      raise exception 'comanda não está aberta (já foi fechada em outro aparelho?)';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(p_items) as i
       where not exists (
         select 1
           from public.tab_items ti
          where ti.tab_client_id = p_tab_client_id
            and ti.product_client_id = (i->>'product_client_id')::uuid
            and abs((i->>'unit_price')::numeric - ti.unit_price) <= 0.01
            and (i->>'quantity')::numeric <= ti.quantity
       )
    ) then
      raise exception 'quantidade paga maior que a disponível na comanda, ou preço divergente';
    end if;
  end if;

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_price')::numeric), 0)
    into v_total
    from jsonb_array_elements(p_items) as i;

  select coalesce(sum((pmt->>'amount')::numeric), 0)
    into v_payments_sum
    from jsonb_array_elements(p_payments) as pmt;
  if abs(v_payments_sum - v_total) > 0.01 then
    raise exception 'soma das formas de pagamento (%) diverge do total da venda (%)', v_payments_sum, v_total;
  end if;

  v_payment_method := case
    when v_payments_count = 1 then (p_payments->0->>'method')
    else 'split'
  end;

  insert into public.sales (
    tenant_id, client_id, total_amount, payment_method, consumption_mode, sale_date, synced_at, tab_client_id
  )
  values (
    p_tenant_id, p_client_id, v_total, v_payment_method, p_consumption_mode, now(), now(), p_tab_client_id
  );

  insert into public.sale_payments (client_id, sale_client_id, method, amount)
  select
    gen_random_uuid(),
    p_client_id,
    pmt->>'method',
    (pmt->>'amount')::numeric
  from jsonb_array_elements(p_payments) as pmt;

  insert into public.sale_items (client_id, sale_client_id, product_client_id, quantity, unit_price)
  select
    gen_random_uuid(),
    p_client_id,
    (i->>'product_client_id')::uuid,
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric
  from jsonb_array_elements(p_items) as i;

  if p_tab_client_id is not null then
    select not exists (
      select 1
        from public.tab_items ti
       where ti.tab_client_id = p_tab_client_id
         and not exists (
           select 1
             from jsonb_array_elements(p_items) as i
            where (i->>'product_client_id')::uuid = ti.product_client_id
              and (i->>'quantity')::numeric >= ti.quantity
         )
    ) into v_is_full_payment;

    delete from public.tab_items ti
      using (
        select (i->>'product_client_id')::uuid as product_client_id,
               (i->>'quantity')::numeric as paid_qty
          from jsonb_array_elements(p_items) as i
      ) x
     where ti.tab_client_id = p_tab_client_id
       and ti.product_client_id = x.product_client_id
       and ti.quantity <= x.paid_qty;

    update public.tab_items ti
       set quantity = ti.quantity - x.paid_qty,
           updated_at = now()
      from (
        select (i->>'product_client_id')::uuid as product_client_id,
               (i->>'quantity')::numeric as paid_qty
          from jsonb_array_elements(p_items) as i
      ) x
     where ti.tab_client_id = p_tab_client_id
       and ti.product_client_id = x.product_client_id;

    if p_queue then
      -- Um só ticket ativo por comanda: se já existe um pendente/pronto, o
      -- pedido novo entra nele; senão, nasce um novo (ver MOTIVAÇÃO acima).
      select id into v_ticket_id
        from public.kitchen_tickets
       where tab_client_id = p_tab_client_id
         and status in ('pending', 'ready')
       limit 1;

      select jsonb_agg(jsonb_build_object('name', i->>'name', 'quantity', (i->>'quantity')::numeric))
        into v_ticket_items
        from jsonb_array_elements(p_items) as i;

      if v_ticket_id is not null then
        update public.kitchen_tickets
           set items = items || v_ticket_items,
               status = 'pending',
               ready_at = null,
               updated_at = now()
         where id = v_ticket_id;
      else
        select t.customer_name into v_customer_name
          from public.tabs t
         where t.client_id = p_tab_client_id;

        insert into public.kitchen_tickets (
          client_id, tenant_id, sale_client_id, tab_client_id, customer_name, items
        )
        values (
          gen_random_uuid(), p_tenant_id, p_client_id, p_tab_client_id, v_customer_name, v_ticket_items
        );
      end if;

      update public.tabs
         set updated_at = now()
       where client_id = p_tab_client_id
         and tenant_id = p_tenant_id;
    elsif v_is_full_payment then
      update public.tabs
         set status = 'closed', closed_at = now(), sale_client_id = p_client_id, updated_at = now()
       where client_id = p_tab_client_id
         and tenant_id = p_tenant_id
         and status = 'open';
    else
      update public.tabs
         set updated_at = now()
       where client_id = p_tab_client_id
         and tenant_id = p_tenant_id;
    end if;
  end if;

  return p_client_id;
end;
$$;

comment on function public.create_sale(uuid, uuid, jsonb, text, jsonb, uuid, boolean) is
  'Registra venda + pagamentos (1 ou mais formas) + itens + baixa de estoque em UMA transação. Com p_tab_client_id, baixa da comanda o que foi pago (total ou parcial). p_queue=true junta o pedido no kitchen_ticket ATIVO da comanda (ou cria um, se não houver) e NUNCA fecha a comanda; sem fila, fecha só se o pagamento foi total. Idempotente por client_id; total calculado no servidor.';

revoke all on function public.create_sale(uuid, uuid, jsonb, text, jsonb, uuid, boolean) from public;
grant execute on function public.create_sale(uuid, uuid, jsonb, text, jsonb, uuid, boolean) to authenticated;

-- Junta os tickets já duplicados (criados pela MIGRATION_29 antes desta
-- correção) por comanda: mantém um deles ('ready' vence 'pending' se houver
-- mistura, pra não perder um "já pronto"; empate = mais antigo), concatena os
-- itens de TODOS os duplicados nele e apaga os demais.
do $$
declare
  r record;
  keep_id uuid;
  merged_items jsonb;
begin
  for r in
    select tab_client_id
      from public.kitchen_tickets
     where status in ('pending', 'ready')
       and tab_client_id is not null
     group by tab_client_id
    having count(*) > 1
  loop
    select id into keep_id
      from public.kitchen_tickets
     where tab_client_id = r.tab_client_id
       and status in ('pending', 'ready')
     order by (status = 'ready') desc, created_at asc
     limit 1;

    select jsonb_agg(elem) into merged_items
      from public.kitchen_tickets kt,
           jsonb_array_elements(kt.items) as elem
     where kt.tab_client_id = r.tab_client_id
       and kt.status in ('pending', 'ready');

    update public.kitchen_tickets
       set items = merged_items, updated_at = now()
     where id = keep_id;

    delete from public.kitchen_tickets
     where tab_client_id = r.tab_client_id
       and status in ('pending', 'ready')
       and id <> keep_id;
  end loop;
end $$;
