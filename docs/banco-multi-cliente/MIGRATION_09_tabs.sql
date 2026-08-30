-- =====================================================================
-- MIGRATION 09 — Comandas (tabs) no servidor
-- Aplica SOBRE SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql + MIGRATION_08_create_sale.
-- Idempotente.
--
-- MOTIVAÇÃO:
--   Hoje a comanda é estado de trabalho LOCAL do aparelho: existe só no SQLite
--   do celular e nunca sobe. Com um segundo cliente (o PWA no iPhone), isso
--   significa que a comanda aberta no Android não existe para quem atende pelo
--   iPhone — e vice-versa. Num balcão com dois pontos de atendimento, isso é
--   inaceitável: dois operadores anotariam pedidos da mesma mesa em lugares
--   diferentes, e o estoque reservado por uma comanda seria invisível à outra.
--
--   Estas tabelas passam a ser a fonte da verdade das comandas ABERTAS. O app
--   mobile continua offline-first (grava local e sincroniza); o web lê e escreve
--   direto aqui.
--
-- DECISÕES:
--   • `status` em vez de apagar a linha: o fechamento precisa sobreviver ao
--     sync (o celular que fechou pode estar offline) e a comanda fechada guarda
--     o vínculo com a venda que ela gerou. Comanda "aberta" é status = 'open'.
--   • UNIQUE (tab_client_id, product_client_id): a comanda tem UMA linha por
--     produto (adicionar de novo soma quantidade), igual ao app. É o que permite
--     ao sync fazer upsert sem duplicar item.
--   • `name` e `unit_price` são SNAPSHOT do momento em que o item entrou: mudar
--     o preço do produto não pode alterar o valor de uma comanda já aberta.
--   • create_sale ganha `p_tab_client_id`: fechar comanda vira venda E marca a
--     comanda como fechada na MESMA transação. Sem isso, uma falha entre os dois
--     passos deixaria a comanda aberta com a venda já cobrada (ou o contrário).
-- =====================================================================

-- 1) Tabelas ----------------------------------------------------------

create table if not exists public.tabs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  client_id      uuid not null unique, -- idempotência do sync (igual às demais)
  user_id        uuid not null default auth.uid() references auth.users (id) on delete restrict,
  -- rótulo da comanda ("João da mesa 3"); não é cadastro de cliente.
  customer_name  varchar(120) not null,
  status         varchar(20) not null default 'open' check (status in ('open', 'closed')),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  -- venda gerada no fechamento (null enquanto aberta ou se foi descartada).
  sale_client_id uuid references public.sales (client_id) on delete set null,
  updated_at     timestamptz not null default now()
);

create table if not exists public.tab_items (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null unique,
  tab_client_id     uuid not null references public.tabs (client_id) on delete cascade,
  product_client_id uuid not null references public.products (client_id) on delete restrict,
  name              varchar(120) not null,
  unit_price        numeric(10,2) not null check (unit_price >= 0),
  quantity          numeric(10,3) not null check (quantity > 0),
  updated_at        timestamptz not null default now(),
  constraint tab_items_unique unique (tab_client_id, product_client_id)
);

-- 2) Índices ----------------------------------------------------------
-- A consulta quente é "comandas abertas desta empresa".
create index if not exists idx_tabs_tenant_status on public.tabs (tenant_id, status, opened_at);
-- tab_items: a UNIQUE (tab_client_id, product_client_id) já indexa a FK do pai.

-- 3) RLS --------------------------------------------------------------
-- Comandas seguem a regra das VENDAS: todo membro opera (o caixa precisa abrir e
-- fechar comanda). O isolamento é por empresa.
alter table public.tabs      enable row level security;
alter table public.tab_items enable row level security;

drop policy if exists tenant_all on public.tabs;
create policy tenant_all on public.tabs for all to authenticated
  using      (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

-- Itens isolam pela comanda-pai (mesmo padrão de sale_items).
drop policy if exists tenant_all on public.tab_items;
create policy tenant_all on public.tab_items for all to authenticated
  using      (exists (select 1 from public.tabs t
                      where t.client_id = tab_client_id
                        and t.tenant_id in (select public.user_tenant_ids())))
  with check (exists (select 1 from public.tabs t
                      where t.client_id = tab_client_id
                        and t.tenant_id in (select public.user_tenant_ids())));

-- 4) Realtime ---------------------------------------------------------
-- O ganho da comanda no servidor é o balcão ver o pedido na hora; sem realtime,
-- o outro aparelho só descobriria no próximo ciclo de sync.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tabs'
    ) then
      alter publication supabase_realtime add table public.tabs;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tab_items'
    ) then
      alter publication supabase_realtime add table public.tab_items;
    end if;
  end if;
end $$;

-- 5) create_sale com fechamento de comanda ----------------------------
-- DROP antes do CREATE: acrescentar um parâmetro com DEFAULT criaria uma
-- SOBRECARGA, e a chamada com 5 argumentos passaria a ser ambígua ("function is
-- not unique"). A versão de 5 argumentos deixa de existir.
drop function if exists public.create_sale(uuid, uuid, text, text, jsonb);

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
  'Registra venda + itens + baixa de estoque (e fecha a comanda, se informada) em UMA transação. Idempotente por client_id; total calculado no servidor.';

revoke all on function public.create_sale(uuid, uuid, text, text, jsonb, uuid) from public;
grant execute on function public.create_sale(uuid, uuid, text, text, jsonb, uuid) to authenticated;

-- 6) updated_at -------------------------------------------------------
-- Mesmo padrão das demais tabelas (a função já existe no schema base).
do $$
declare t text;
begin
  foreach t in array array['tabs', 'tab_items'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on public.%1$s
         for each row execute function public.update_updated_at_column();', t);
  end loop;
end $$;
