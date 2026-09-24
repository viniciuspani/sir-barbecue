-- =====================================================================
-- MIGRATION 29 — Ticket de cozinha separado da comanda
-- Aplica SOBRE MIGRATION_28_split_and_partial_tab_payment.sql (create_sale vigente).
-- Idempotente.
--
-- MOTIVAÇÃO:
--   Comanda pré-paga ("Receber e mandar p/ churrasqueira") marcava a comanda
--   INTEIRA como status='paid'/'ready' — ela saía da lista "Em aberto" e não
--   podia mais receber item novo. Um cliente que pede várias vezes seguidas
--   (ex.: "Zé da Rua" pedindo 5 rodadas) obrigava o operador a criar uma
--   comanda nova a cada rodada, digitando o nome de novo.
--
--   Raiz do problema: a fila da churrasqueira lia ao vivo os tab_items de
--   qualquer comanda em status='paid'/'ready' — ela não tinha cópia própria
--   do que foi mandado pra cozinha. Por isso "comanda aberta pra novos
--   pedidos" e "comanda visível na fila da churrasqueira" eram o MESMO status,
--   mutuamente exclusivos.
--
-- DECISÕES:
--   • kitchen_tickets é tabela NOVA, uma linha por venda pré-paga (ligada via
--     sales.tab_client_id, da MIGRATION_28) — não mais um status de tabs.
--     tabs.status volta a ser só 'open'/'closed'/'cancelled': a comanda NUNCA
--     fecha sozinha por causa de pagamento (nem total, nem parcial) no fluxo
--     pré-pago; só fecha quando o operador fecha de propósito.
--   • Por que tabela nova em vez de status em sales: o sync do app mobile
--     assume sales IMUTÁVEL depois de gravada (nunca tenta fazer pull de
--     atualização numa venda já puxada). O status de cozinha precisa mudar
--     depois de criado (pending→ready→delivered) e propagar entre aparelhos
--     (o celular do churrasqueiro marca "Pronto", o caixa precisa ver) — nova
--     tabela evita quebrar essa suposição.
--   • customer_name e items (snapshot [{name, quantity}]) ficam DENORMALIZADOS
--     em kitchen_tickets — mesmo padrão que tab_items já usa (name/unit_price
--     denormalizados) pra a fila não precisar de join com products/tabs.
--   • "Total" vs "parcial" continua existindo, mas só controla se um pagamento
--     SEM fila (p_queue=false, botão "Receber e encerrar") também FECHA a
--     comanda — total fecha (comportamento de sempre), parcial mantém aberta
--     (comportamento de sempre). No fluxo COM fila (p_queue=true), a comanda
--     NUNCA fecha, seja pagamento total ou parcial do que está nela agora —
--     é exatamente essa a mudança desta migração.
--   • tab_items sempre é decrementado (delete-então-update, já corrigido na
--     MIGRATION_28) — não tem mais ramo "pagamento total não mexe": esse ramo
--     só existia pra não quebrar a fila antiga baseada em status; a fila nova
--     não lê mais tab_items.
-- =====================================================================

-- 1) kitchen_tickets ------------------------------------------------------
create table if not exists public.kitchen_tickets (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null unique,
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  sale_client_id uuid not null unique references public.sales (client_id) on delete cascade,
  -- null se a comanda for excluída depois (on delete set null) — o ticket
  -- em si é histórico de venda e não deveria sumir junto.
  tab_client_id  uuid references public.tabs (client_id) on delete set null,
  customer_name  varchar(120) not null,
  -- snapshot: [{ "name": text, "quantity": numeric }, ...]
  items          jsonb not null,
  status         varchar(20) not null default 'pending'
                   check (status in ('pending', 'ready', 'delivered')),
  created_at     timestamptz not null default now(),
  ready_at       timestamptz,
  delivered_at   timestamptz,
  updated_at     timestamptz not null default now()
);

create index if not exists idx_kitchen_tickets_tenant_status
  on public.kitchen_tickets (tenant_id, status, created_at);

alter table public.kitchen_tickets enable row level security;

-- Mesmo padrão de tabs/sales: isola direto por tenant_id (coluna própria, sem
-- precisar de EXISTS via pai) — o churrasqueiro lê e escreve como qualquer
-- membro (mesma regra de tabs_write, RLS não distingue papel aqui).
drop policy if exists tenant_all on public.kitchen_tickets;
create policy tenant_all on public.kitchen_tickets for all to authenticated
  using      (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kitchen_tickets'
    ) then
      alter publication supabase_realtime add table public.kitchen_tickets;
    end if;
  end if;
end $$;

drop trigger if exists trg_kitchen_tickets_updated_at on public.kitchen_tickets;
create trigger trg_kitchen_tickets_updated_at before update on public.kitchen_tickets
  for each row execute function public.update_updated_at_column();

-- 2) create_sale — pré-pago vira kitchen_ticket, nunca fecha a comanda ----
-- Mesma assinatura da MIGRATION_28 (create or replace, sem troca de tipos de
-- parâmetro — não precisa de DROP antes).
create or replace function public.create_sale(
  p_tenant_id        uuid,
  p_client_id        uuid,
  -- [{ "method": "pix"|"cash"|"credit_card"|"debit_card", "amount": numeric }, ...]
  -- soma tem que bater com o total da venda (tolerância 0,01).
  p_payments         jsonb,
  p_consumption_mode text,
  -- [{ "product_client_id": uuid, "quantity": numeric, "unit_price": numeric,
  --    "name": text }, ...] — "name" só é lido ao montar o kitchen_ticket
  -- (p_queue=true); nas demais vendas o campo é ignorado.
  -- Quando p_tab_client_id é informado, pode ser um SUBCONJUNTO da comanda
  -- (pagamento parcial) — o que não estiver aqui continua na comanda aberta.
  p_items            jsonb,
  p_tab_client_id    uuid default null,
  -- true = pedido pré-pago: gera ticket de cozinha; a comanda NUNCA fecha
  -- neste caminho, seja pagamento total ou parcial do que ela tem agora.
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
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'venda sem itens';
  end if;

  -- Idempotência antes das guardas: retry de venda já gravada não pode falhar.
  if exists (select 1 from public.sales where client_id = p_client_id) then
    return p_client_id;
  end if;

  -- Guarda (MIGRATION_24): exclusão agendada não é problema de cobrança.
  if exists (select 1 from public.account_deletion_requests r
              where r.tenant_id = p_tenant_id and r.status = 'pending') then
    raise exception 'exclusão de conta agendada: cancele a solicitação para voltar a vender';
  end if;

  -- Guarda de assinatura (A06-01). A RLS já barraria; isto é pela mensagem.
  if not public.tenant_has_access(p_tenant_id) then
    raise exception 'assinatura inativa: regularize para continuar vendendo';
  end if;

  -- Guarda das formas de pagamento: array não vazio, métodos válidos, sem
  -- forma repetida (duas linhas 'pix' não fazem sentido — é uma única forma).
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

  -- Guarda de preço (A06-02) + guarda de quantidade paga (comanda).
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
    -- Trava a comanda ANTES de validar/decrementar: serializa dois caixas
    -- mexendo na mesma comanda ao mesmo tempo (dois pagamentos concorrentes).
    -- Sem isto, a leitura de validação de uma transação não vê a escrita
    -- ainda não commitada da outra e tab_items.quantity pode ir a negativo.
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
            -- não pode pagar mais do que a comanda realmente tem deste item.
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

  if p_tab_client_id is not null then
    -- "Total" = p_items cobre CADA linha da comanda por inteiro (nenhuma fica
    -- de fora, nenhuma sobra quantidade) — usado só pra decidir, no ramo SEM
    -- fila abaixo, se o pagamento também fecha a comanda.
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

    -- Sempre baixa o que foi pago da comanda — total ou parcial, com ou sem
    -- fila. Apaga PRIMEIRO o que foi consumido por inteiro (a guarda acima já
    -- garante paid_qty <= quantity); um UPDATE direto pra quantity=0 violaria
    -- o CHECK (quantity > 0) antes de um DELETE seguinte limpar a linha.
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
      -- Pré-pago: gera o ticket de cozinha. A comanda NUNCA fecha aqui, nem
      -- quando o pagamento é total do que ela tem agora — é assim que o
      -- mesmo cliente consegue pedir de novo sem o operador recriar a
      -- comanda a cada rodada.
      select t.customer_name into v_customer_name
        from public.tabs t
       where t.client_id = p_tab_client_id;

      select jsonb_agg(jsonb_build_object('name', i->>'name', 'quantity', (i->>'quantity')::numeric))
        into v_ticket_items
        from jsonb_array_elements(p_items) as i;

      insert into public.kitchen_tickets (
        client_id, tenant_id, sale_client_id, tab_client_id, customer_name, items
      )
      values (
        gen_random_uuid(), p_tenant_id, p_client_id, p_tab_client_id, v_customer_name, v_ticket_items
      );

      update public.tabs
         set updated_at = now()
       where client_id = p_tab_client_id
         and tenant_id = p_tenant_id;
    elsif v_is_full_payment then
      -- Pagou tudo SEM fila: encerra de vez — comportamento de sempre do
      -- botão "Receber e encerrar".
      update public.tabs
         set status = 'closed', closed_at = now(), sale_client_id = p_client_id, updated_at = now()
       where client_id = p_tab_client_id
         and tenant_id = p_tenant_id
         and status = 'open';
    else
      -- Pagamento parcial SEM fila: comanda continua aberta com o restante —
      -- comportamento de sempre do pagamento parcial.
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
  'Registra venda + pagamentos (1 ou mais formas) + itens + baixa de estoque em UMA transação. Com p_tab_client_id, baixa da comanda o que foi pago (total ou parcial). p_queue=true gera um kitchen_ticket e NUNCA fecha a comanda; sem fila, fecha só se o pagamento foi total. Idempotente por client_id; total calculado no servidor.';

revoke all on function public.create_sale(uuid, uuid, jsonb, text, jsonb, uuid, boolean) from public;
grant execute on function public.create_sale(uuid, uuid, jsonb, text, jsonb, uuid, boolean) to authenticated;

-- 3) Migração de dados: destrava comandas já em 'paid'/'ready' -------------
-- Comandas que já passaram pelo fluxo antigo (ex.: os testes feitos antes
-- desta migração) ficaram travadas em status='paid'/'ready', com tab_items
-- intocados (a correção da MIGRATION_28 deixava assim de propósito, pro
-- modelo ANTIGO da fila). No modelo novo, isso vira: 1 kitchen_ticket (com o
-- snapshot dos itens que ainda estavam lá) + a comanda volta a 'open' + os
-- tab_items (já pagos) são apagados.
insert into public.kitchen_tickets (client_id, tenant_id, sale_client_id, tab_client_id, customer_name, items, status, created_at)
select
  gen_random_uuid(),
  t.tenant_id,
  t.sale_client_id,
  t.client_id,
  t.customer_name,
  coalesce(
    (select jsonb_agg(jsonb_build_object('name', ti.name, 'quantity', ti.quantity))
       from public.tab_items ti
      where ti.tab_client_id = t.client_id),
    '[]'::jsonb
  ),
  case when t.status = 'ready' then 'ready' else 'pending' end,
  coalesce(t.paid_at, t.opened_at)
from public.tabs t
where t.status in ('paid', 'ready')
  and t.sale_client_id is not null
  and not exists (
    select 1 from public.kitchen_tickets kt where kt.sale_client_id = t.sale_client_id
  );

delete from public.tab_items ti
 using public.tabs t
 where ti.tab_client_id = t.client_id
   and t.status in ('paid', 'ready');

update public.tabs
   set status = 'open'
 where status in ('paid', 'ready');
