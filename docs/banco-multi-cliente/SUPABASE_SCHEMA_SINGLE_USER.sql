-- =====================================================================
-- Sir Barbecue — SCHEMA SUPABASE (PostgreSQL) — VERSÃO SINGLE-USER (1 empresa = 1 login)
-- Cobre a Sugestão 2 da avaliação multi-cliente.
--
-- Modelo: cada CONTA de usuário (auth.users) é uma EMPRESA independente.
-- "Churrasquinho do Zé" e "Espetaria do João" = dois logins separados; a RLS
-- por user_id já os isola 100%. Único acréscimo sobre o schema original:
-- a tabela business_profile (1:1 com o usuário) para guardar os dados do negócio
-- (nome fantasia, CNPJ, logo, telefone).
--
-- ✔ Esforço mínimo, ZERO mudança no modelo de segurança existente.
-- ✘ NÃO suporta vários funcionários/logins compartilhando os mesmos dados.
--   (Para isso, use a versão SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql.)
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run. Idempotente.
-- =====================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Função compartilhada: atualiza updated_at automaticamente
-- ---------------------------------------------------------------------
create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- =====================================================================
-- TABELAS (ordem por dependência de FK)
-- =====================================================================

-- 0) business_profile (Sugestão 2 — dados do negócio, 1:1 com o usuário) ----
create table if not exists public.business_profile (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name       varchar(200),            -- nome fantasia (ex.: "Churrasquinho do Zé")
  legal_name varchar(200),            -- razão social
  cnpj       varchar(18),
  logo_url   text,
  phone      varchar(20),
  address    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1) categories ------------------------------------------------------
create table if not exists public.categories (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null unique,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name          varchar(100) not null,
  slug          varchar(100) not null,
  display_order smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint categories_name_user_unique unique (user_id, name),
  constraint categories_slug_user_unique unique (user_id, slug)
);

-- 2) products --------------------------------------------------------
create table if not exists public.products (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null unique,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete restrict,
  category_client_id uuid references public.categories (client_id) on delete restrict,
  name               varchar(200) not null,
  description        text,
  price              numeric(10,2) not null check (price >= 0),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint products_name_user_unique unique (user_id, name)
);

-- 3) product_day_visibility (RF-05) ----------------------------------
create table if not exists public.product_day_visibility (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null unique,
  product_client_id uuid not null references public.products (client_id) on delete cascade,
  day_of_week       smallint not null check (day_of_week between 0 and 6), -- 0=Dom ... 6=Sáb
  is_visible        boolean not null default true,
  updated_at        timestamptz not null default now(),
  constraint product_day_visibility_unique unique (product_client_id, day_of_week)
);

-- 4) suppliers -------------------------------------------------------
create table if not exists public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null unique,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name         varchar(200) not null,
  address      text,
  contact_name varchar(200),
  phone        varchar(20),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 5) product_suppliers (N:N produto<->fornecedor + custo) ------------
create table if not exists public.product_suppliers (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null unique,
  product_client_id  uuid not null references public.products (client_id) on delete restrict,
  supplier_client_id uuid not null references public.suppliers (client_id) on delete restrict,
  purchase_price     numeric(10,2) not null check (purchase_price >= 0),
  is_preferred       boolean not null default false,
  updated_at         timestamptz not null default now(),
  constraint product_suppliers_unique unique (product_client_id, supplier_client_id)
);

-- 6) stock_items (saldo atual por produto) ---------------------------
create table if not exists public.stock_items (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null unique,
  product_client_id uuid not null unique references public.products (client_id) on delete restrict,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete restrict,
  quantity          numeric(10,3) not null default 0 check (quantity >= 0),
  alert_threshold   numeric(10,3) not null default 0, -- dispara alerta push (RF-11)
  updated_at        timestamptz not null default now()
);

-- 7) stock_entries (histórico de entradas — imutável) ----------------
create table if not exists public.stock_entries (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null unique,
  product_client_id  uuid not null references public.products (client_id) on delete restrict,
  supplier_client_id uuid references public.suppliers (client_id) on delete restrict,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete restrict,
  quantity           numeric(10,3) not null check (quantity > 0),
  unit_cost          numeric(10,2) check (unit_cost >= 0),
  entry_date         timestamptz not null default now(),
  notes              text,
  updated_at         timestamptz not null default now()
);

-- 8) sales (offline-first) -------------------------------------------
create table if not exists public.sales (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null unique, -- idempotência (ON CONFLICT (client_id))
  user_id          uuid not null default auth.uid() references auth.users (id) on delete restrict,
  total_amount     numeric(10,2) not null check (total_amount >= 0),
  payment_method   varchar(20) not null check (payment_method in ('cash','pix','credit_card','debit_card')),
  consumption_mode varchar(20) not null default 'on_site' check (consumption_mode in ('on_site','takeaway')),
  sale_date        timestamptz not null default now(),
  notes            text,
  synced_at        timestamptz, -- NULL = registrada offline ainda não sincronizada
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 9) sale_items (preço no MOMENTO da venda) --------------------------
create table if not exists public.sale_items (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null unique,
  sale_client_id    uuid not null references public.sales (client_id) on delete cascade,
  product_client_id uuid not null references public.products (client_id) on delete restrict,
  quantity          numeric(10,3) not null check (quantity > 0),
  unit_price        numeric(10,2) not null check (unit_price >= 0),
  subtotal          numeric(12,2) generated always as (quantity * unit_price) stored,
  updated_at        timestamptz not null default now()
);

-- 10) reports (metadados; arquivos no Storage) -----------------------
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null unique,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete restrict,
  type          varchar(50) not null check (type in ('daily_sales','monthly_sales','products_sold','financial_summary')),
  status        varchar(20) not null default 'pending' check (status in ('pending','processing','ready','failed')),
  parameters    jsonb not null default '{}',
  pdf_url       text,
  html_url      text,
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- 11) sync_checkpoints (robustez multi-device do MESMO usuário) -------
create table if not exists public.sync_checkpoints (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_id      varchar(100) not null,
  table_name     varchar(100) not null,
  last_synced_at timestamptz not null default now(),
  constraint sync_checkpoints_unique unique (user_id, device_id, table_name)
);

-- =====================================================================
-- TRIGGERS de updated_at (inclui business_profile)
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'business_profile','categories','products','product_day_visibility','suppliers','product_suppliers',
    'stock_items','stock_entries','sales','sale_items','reports'
  ] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on public.%1$s
         for each row execute function public.update_updated_at_column();', t);
  end loop;
end $$;

-- =====================================================================
-- TRIGGERS de negócio (estoque) — inalterados
-- =====================================================================

-- Dedução automática de estoque ao inserir item de venda (RF-10)
create or replace function public.deduct_stock_on_sale()
returns trigger language plpgsql as $$
begin
  update public.stock_items
    set quantity = quantity - new.quantity, updated_at = now()
    where product_client_id = new.product_client_id;
  return new;
end; $$;
drop trigger if exists trg_deduct_stock_on_sale on public.sale_items;
create trigger trg_deduct_stock_on_sale
  after insert on public.sale_items
  for each row execute function public.deduct_stock_on_sale();

-- Incremento de estoque ao registrar entrada (RF-09)
create or replace function public.increment_stock_on_entry()
returns trigger language plpgsql as $$
begin
  insert into public.stock_items (client_id, product_client_id, user_id, quantity)
    values (gen_random_uuid(), new.product_client_id, new.user_id, new.quantity)
  on conflict (product_client_id)
    do update set quantity = public.stock_items.quantity + new.quantity, updated_at = now();
  return new;
end; $$;
drop trigger if exists trg_increment_stock_on_entry on public.stock_entries;
create trigger trg_increment_stock_on_entry
  after insert on public.stock_entries
  for each row execute function public.increment_stock_on_entry();

-- =====================================================================
-- ÍNDICES (por user_id — inalterados; + índice de business_profile)
-- =====================================================================
create index if not exists idx_sales_user_date          on public.sales (user_id, sale_date desc);
create index if not exists idx_sales_user_payment        on public.sales (user_id, payment_method, sale_date);
create index if not exists idx_sales_not_synced          on public.sales (user_id, synced_at) where synced_at is null;
create index if not exists idx_sale_items_sale           on public.sale_items (sale_client_id);
create index if not exists idx_sale_items_product        on public.sale_items (product_client_id);
create index if not exists idx_stock_items_user          on public.stock_items (user_id);
create index if not exists idx_stock_items_alert         on public.stock_items (user_id, quantity, alert_threshold) where alert_threshold > 0;
create index if not exists idx_products_user_active      on public.products (user_id, is_active, category_client_id) where is_active = true;
create index if not exists idx_product_suppliers_product on public.product_suppliers (product_client_id, is_preferred);
-- business_profile já tem PK em user_id (1:1), não requer índice adicional.

-- =====================================================================
-- ROW LEVEL SECURITY (cada usuário só acessa seus próprios dados)
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'business_profile','categories','products','product_day_visibility','suppliers','product_suppliers',
    'stock_items','stock_entries','sales','sale_items','reports','sync_checkpoints'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- Policies: tabelas com user_id direto (inclui business_profile — Sugestão 2)
do $$
declare t text;
begin
  foreach t in array array[
    'business_profile','categories','products','suppliers','stock_items','stock_entries','sales','reports','sync_checkpoints'
  ] loop
    execute format('drop policy if exists owner_all on public.%I;', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid());', t);
  end loop;
end $$;

-- Policies: tabelas filhas (RLS pelo dono do registro pai, via client_id)
drop policy if exists owner_all on public.product_day_visibility;
create policy owner_all on public.product_day_visibility for all to authenticated
  using      (exists (select 1 from public.products p where p.client_id = product_client_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.products p where p.client_id = product_client_id and p.user_id = auth.uid()));

drop policy if exists owner_all on public.product_suppliers;
create policy owner_all on public.product_suppliers for all to authenticated
  using      (exists (select 1 from public.products p where p.client_id = product_client_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.products p where p.client_id = product_client_id and p.user_id = auth.uid()));

drop policy if exists owner_all on public.sale_items;
create policy owner_all on public.sale_items for all to authenticated
  using      (exists (select 1 from public.sales s where s.client_id = sale_client_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.sales s where s.client_id = sale_client_id and s.user_id = auth.uid()));

-- =====================================================================
-- SEED: ao criar usuário → categorias padrão + linha em business_profile (Sugestão 2)
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Perfil do negócio (vazio; nome pode vir do metadado 'business_name')
  insert into public.business_profile (user_id, name)
    values (new.id, nullif(new.raw_user_meta_data->>'business_name',''))
  on conflict (user_id) do nothing;

  -- Categorias padrão (RF-03/04)
  insert into public.categories (client_id, user_id, name, slug, display_order) values
    (gen_random_uuid(), new.id, 'Churrasquinho', 'churrasquinho', 1),
    (gen_random_uuid(), new.id, 'Bebidas',       'bebidas',       2),
    (gen_random_uuid(), new.id, 'Lanches',       'lanches',       3),
    (gen_random_uuid(), new.id, 'Especiais',     'especiais',     4)
  on conflict (user_id, name) do nothing;

  return new;
end; $$;
drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- STORAGE: bucket privado para PDFs/HTMLs de relatórios (RF-24)
-- Isolado por pasta do usuário: reports/<uid>/arquivo
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

drop policy if exists reports_owner_read on storage.objects;
create policy reports_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'reports' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- FIM — VERSÃO SINGLE-USER (Sugestão 2)
--
-- Atende: "Churrasquinho do Zé" e "Espetaria do João" como contas separadas,
-- cada login com seus próprios produtos, vendas, estoque e relatórios.
-- Para evoluir a múltiplos funcionários por empresa, migrar para
-- SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql (modelo de tenants).
-- =====================================================================
