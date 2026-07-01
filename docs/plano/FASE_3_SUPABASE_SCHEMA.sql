-- =====================================================================
-- Fase 3 — Schema Supabase (sync offline-first) — Sir Barbecue
-- Rode no Supabase: SQL Editor → New query → cole tudo → Run.
-- Cobre as tabelas que o Sync Engine envia/recebe (products, sales, sale_items).
-- Idempotência: UNIQUE(client_id) (casa com o upsert onConflict: 'client_id').
-- Isolamento por usuário: RLS (user_id = auth.uid()) — doc 01c §8.2 / ADR-005.
-- =====================================================================

-- updated_at automático
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- ---------- products ----------
create table if not exists public.products (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null unique,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null,
  price        numeric(10,2) not null,
  is_active    boolean not null default true,
  category_id  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_products_user on public.products (user_id);
drop trigger if exists trg_products_updated on public.products;
create trigger trg_products_updated before update on public.products
  for each row execute function public.set_updated_at();

-- ---------- sales ----------
create table if not exists public.sales (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null unique,
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sale_date        timestamptz not null,
  total_amount     numeric(10,2) not null,
  payment_method   text not null,
  consumption_mode text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_sales_user on public.sales (user_id);
drop trigger if exists trg_sales_updated on public.sales;
create trigger trg_sales_updated before update on public.sales
  for each row execute function public.set_updated_at();

-- ---------- sale_items ----------
create table if not exists public.sale_items (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null unique,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sale_client_id     uuid not null,
  product_client_id  uuid not null,
  quantity           integer not null,
  unit_price         numeric(10,2) not null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_sale_items_user on public.sale_items (user_id);
create index if not exists idx_sale_items_sale on public.sale_items (sale_client_id);

-- =====================================================================
-- Row Level Security — cada usuário só acessa seus próprios dados
-- =====================================================================
alter table public.products   enable row level security;
alter table public.sales      enable row level security;
alter table public.sale_items enable row level security;

do $$
declare t text;
begin
  foreach t in array array['products','sales','sale_items'] loop
    execute format('drop policy if exists owner_all on public.%I;', t);
    execute format(
      'create policy owner_all on public.%I
         for all to authenticated
         using (user_id = auth.uid())
         with check (user_id = auth.uid());', t);
  end loop;
end $$;

-- Pronto. O app faz upsert com client_id (idempotente) e o RLS preenche/valida o user_id.
