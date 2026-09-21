-- =====================================================================
-- MIGRATION 28 — Pagamento dividido + pagamento parcial de comanda
-- Aplica SOBRE MIGRATION_27_tabs_queue.sql (create_sale vigente).
-- Idempotente.
--
-- MOTIVAÇÃO:
--   1) Cliente quer pagar parte no débito e parte no crédito (ou qualquer
--      combinação das 4 formas). Hoje sales.payment_method é UM valor só —
--      a venda só aceita uma forma de pagamento.
--   2) Numa comanda aberta, alguém da mesa quer pagar só os itens/quantidades
--      que consumiu e ir embora, deixando o resto na comanda para quem ficou.
--      Hoje fechar comanda é tudo-ou-nada: create_sale sempre marca a comanda
--      INTEIRA como fechada/paga e nunca toca em tab_items — reduzir a
--      quantidade de uma linha na tela de fechamento hoje perde a diferença
--      em silêncio (nem cobra, nem deixa na comanda).
--
-- DECISÕES:
--   • sale_payments é tabela NOVA (não reaproveita sales.payment_method para
--     guardar o split) — sempre populada, até para venda com 1 forma só, pra
--     virar a fonte única de verdade de forma de pagamento daqui pra frente.
--     sales.payment_method continua existindo (compat com todo código que só
--     lê essa coluna): guarda o método único quando só há 1 linha, ou o
--     literal 'split' quando há 2+.
--   • sales.tab_client_id é coluna NOVA, independente de tabs.sale_client_id.
--     tabs.sale_client_id continua significando especificamente "a venda que
--     fechou/enfileirou esta comanda" (fluxo da fila da churrasqueira). Uma
--     venda de pagamento PARCIAL não fecha a comanda, então não pode ser essa
--     venda — mas precisa de algum jeito de saber de qual comanda ela veio.
--   • create_sale troca p_payment_method (text) por p_payments (jsonb) —
--     mesmo padrão de troca de assinatura das migrações 09/27 (DROP antes do
--     CREATE, senão vira sobrecarga ambígua).
--   • Trava a linha de tabs (FOR UPDATE) antes de decrementar tab_items:
--     sem isso, dois caixas pagando partes da mesma comanda ao mesmo tempo
--     podem levar tab_items.quantity a negativo (a leitura de validação de
--     um não vê a escrita pendente do outro). Travar a comanda inteira é mais
--     simples de raciocinar do que travar linha a linha de tab_items, e o
--     custo só existe quando a MESMA comanda é mexida duas vezes ao mesmo
--     tempo — raro.
--   • Detecção automática de pagamento total vs. parcial: depois de decrementar
--     os itens pagos, se tab_items ficou vazio a comanda fecha/enfileira igual
--     hoje; se sobrou item, ela continua 'open' — sem parâmetro novo pra isso.
-- =====================================================================

-- 1) sale_payments ------------------------------------------------------
create table if not exists public.sale_payments (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null unique,
  sale_client_id uuid not null references public.sales (client_id) on delete cascade,
  method         varchar(20) not null check (method in ('cash','pix','credit_card','debit_card')),
  amount         numeric(10,2) not null check (amount > 0),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_sale_payments_sale on public.sale_payments (sale_client_id);

alter table public.sale_payments enable row level security;

-- Mesmo padrão de sale_items: isola pela venda-pai.
drop policy if exists tenant_all on public.sale_payments;
create policy tenant_all on public.sale_payments for all to authenticated
  using      (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())))
  with check (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sale_payments'
    ) then
      alter publication supabase_realtime add table public.sale_payments;
    end if;
  end if;
end $$;

drop trigger if exists trg_sale_payments_updated_at on public.sale_payments;
create trigger trg_sale_payments_updated_at before update on public.sale_payments
  for each row execute function public.update_updated_at_column();

-- 2) sales.payment_method aceita 'split' --------------------------------
alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
  check (payment_method in ('cash','pix','credit_card','debit_card','split'));

-- 3) sales.tab_client_id -------------------------------------------------
alter table public.sales add column if not exists tab_client_id uuid
  references public.tabs (client_id) on delete set null;

create index if not exists idx_sales_tab on public.sales (tab_client_id) where tab_client_id is not null;

-- 4) create_sale com p_payments + pagamento parcial de comanda ----------
-- Cópia fiel da versão vigente (MIGRATION_27) trocando p_payment_method por
-- p_payments e acrescentando a lógica de decremento parcial de tab_items.
drop function if exists public.create_sale(uuid, uuid, text, text, jsonb, uuid, boolean);

create or replace function public.create_sale(
  p_tenant_id        uuid,
  p_client_id        uuid,
  -- [{ "method": "pix"|"cash"|"credit_card"|"debit_card", "amount": numeric }, ...]
  -- soma tem que bater com o total da venda (tolerância 0,01).
  p_payments         jsonb,
  p_consumption_mode text,
  -- [{ "product_client_id": uuid, "quantity": numeric, "unit_price": numeric }, ...]
  -- quando p_tab_client_id é informado, pode ser um SUBCONJUNTO da comanda
  -- (pagamento parcial) — o que não estiver aqui continua na comanda aberta.
  p_items            jsonb,
  p_tab_client_id    uuid default null,
  -- true = pedido pré-pago: a comanda vai para a fila ('paid') em vez de encerrar.
  p_queue            boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total           numeric(12,2);
  v_payments_sum    numeric(12,2);
  v_payment_method  varchar(20);
  v_payments_count  integer;
  v_distinct_methods integer;
  v_tab_emptied     boolean;
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
    -- mexendo na mesma comanda ao mesmo tempo (dois pagamentos parciais
    -- concorrentes, ou um pagamento parcial concorrendo com um fechamento
    -- inteiro). Sem isto, a leitura de validação de uma transação não vê a
    -- escrita ainda não commitada da outra e tab_items.quantity pode ir a
    -- negativo.
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
    -- Apaga PRIMEIRO o que foi consumido por inteiro (paid_qty = quantity —
    -- a guarda acima já garante paid_qty <= quantity). Fazer isso como UPDATE
    -- para quantity=0 violaria o CHECK (quantity > 0) na hora, antes de um
    -- DELETE seguinte conseguir limpar a linha — o motivo do 23514 no teste.
    delete from public.tab_items ti
      using (
        select (i->>'product_client_id')::uuid as product_client_id,
               (i->>'quantity')::numeric as paid_qty
          from jsonb_array_elements(p_items) as i
      ) x
     where ti.tab_client_id = p_tab_client_id
       and ti.product_client_id = x.product_client_id
       and ti.quantity <= x.paid_qty;

    -- O que sobra (linhas que a DELETE acima não tocou) só decrementa —
    -- nunca chega a zero, porque quem chegaria já foi removido.
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

    select not exists (
      select 1 from public.tab_items where tab_client_id = p_tab_client_id
    ) into v_tab_emptied;

    if v_tab_emptied then
      -- Pagou tudo: comportamento de sempre — fecha ou enfileira a comanda.
      if p_queue then
        update public.tabs
           set status = 'paid', paid_at = now(), sale_client_id = p_client_id, updated_at = now()
         where client_id = p_tab_client_id
           and tenant_id = p_tenant_id
           and status = 'open';
      else
        update public.tabs
           set status = 'closed', closed_at = now(), sale_client_id = p_client_id, updated_at = now()
         where client_id = p_tab_client_id
           and tenant_id = p_tenant_id
           and status = 'open';
      end if;
    else
      -- Pagamento parcial: a comanda continua aberta com o restante.
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
  'Registra venda + pagamentos (1 ou mais formas) + itens + baixa de estoque em UMA transação. Com p_tab_client_id, paga total ou parcialmente a comanda (o que não estiver em p_items continua na comanda aberta); fecha/enfileira só quando ela fica vazia. Idempotente por client_id; total calculado no servidor.';

revoke all on function public.create_sale(uuid, uuid, jsonb, text, jsonb, uuid, boolean) from public;
grant execute on function public.create_sale(uuid, uuid, jsonb, text, jsonb, uuid, boolean) to authenticated;
