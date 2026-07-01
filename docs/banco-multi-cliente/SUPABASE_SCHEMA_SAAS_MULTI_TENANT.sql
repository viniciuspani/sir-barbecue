-- =====================================================================
-- Sir Barbecue — SCHEMA SUPABASE (PostgreSQL) — VERSÃO SAAS MULTI-TENANT
-- Cobre as Sugestões 1 + 3 da avaliação multi-cliente.
--   (1) Empresa como entidade própria (tenants) + equipe/papéis (tenant_members).
--   (3) RLS por empresa via função SECURITY DEFINER + Custom Access Token Hook (JWT claim).
--   (4) NÃO aplicada por padrão: as tabelas filhas (product_day_visibility,
--       product_suppliers, sale_items) ficam NORMALIZADAS, com RLS via EXISTS no pai.
--       A desnormalização de tenant_id (otimização p/ grande volume) está como
--       passo OPCIONAL comentado ao fim do arquivo.
--
-- Objetivo: várias EMPRESAS (ex.: "Churrasquinho do Zé", "Espetaria do João")
-- no MESMO banco (compatível com o plano gratuito do Supabase), cada uma podendo
-- ter vários usuários (dono, gerente, caixa) compartilhando os mesmos dados.
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run. Idempotente.
--
-- Diferenças vs. SUPABASE_SCHEMA_COMPLETO.sql (single-tenant por usuário):
--   • Isolamento passa de user_id → tenant_id (empresa). user_id vira AUDITORIA ("quem registrou").
--   • Tabelas com user_id direto ganham tenant_id NOT NULL; as 3 filhas isolam pelo PAI (EXISTS).
--   • Uniques por empresa: (tenant_id, name) no lugar de (user_id, name).
--   • Seed das categorias padrão dispara na CRIAÇÃO DA EMPRESA, não do usuário.
--   • Novo usuário → cria automaticamente 1 empresa + membership(owner) (bootstrap).
--   • Índices recriados começando por tenant_id.
--   • Storage de relatórios por pasta da empresa: reports/<tenant_id>/arquivo.
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
-- 0) EMPRESAS (tenants) e EQUIPE (tenant_members) — Sugestão 1
-- =====================================================================

-- Empresa / estabelecimento. É a unidade de isolamento de dados.
create table if not exists public.tenants (
  id            uuid primary key default gen_random_uuid(),
  name          varchar(200) not null,            -- nome fantasia (ex.: "Churrasquinho do Zé")
  legal_name    varchar(200),                     -- razão social
  cnpj          varchar(18),
  logo_url      text,
  phone         varchar(20),
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Associação usuário <-> empresa + papel. Permite equipe por empresa.
create table if not exists public.tenant_members (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       varchar(20) not null default 'owner' check (role in ('owner','manager','employee')),
  created_at timestamptz not null default now(),
  constraint tenant_members_unique unique (tenant_id, user_id)
);
create index if not exists idx_tenant_members_user on public.tenant_members (user_id);

-- ---------------------------------------------------------------------
-- Sugestão 3: helpers de associação (SECURITY DEFINER → sem recursão de RLS)
-- ---------------------------------------------------------------------

-- Empresas às quais o usuário logado pertence. Base de TODA a RLS.
-- SECURITY DEFINER: lê tenant_members ignorando a RLS dele (evita recursão).
create or replace function public.user_tenant_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select tm.tenant_id from public.tenant_members tm where tm.user_id = auth.uid();
$$;

-- O usuário logado é OWNER da empresa indicada? (gestão de equipe)
create or replace function public.is_tenant_owner(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id and tm.user_id = auth.uid() and tm.role = 'owner'
  );
$$;

-- =====================================================================
-- TABELAS DE NEGÓCIO (todas com tenant_id NOT NULL — Sugestão 1 e 4)
-- user_id permanece como AUDITORIA (quem registrou), com default auth.uid().
-- =====================================================================

-- 1) categories ------------------------------------------------------
create table if not exists public.categories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  client_id     uuid not null unique,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name          varchar(100) not null,
  slug          varchar(100) not null,
  display_order smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint categories_name_tenant_unique unique (tenant_id, name),
  constraint categories_slug_tenant_unique unique (tenant_id, slug)
);

-- 2) products --------------------------------------------------------
create table if not exists public.products (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  client_id          uuid not null unique,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete restrict,
  category_client_id uuid references public.categories (client_id) on delete restrict,
  name               varchar(200) not null,
  description        text,
  price              numeric(10,2) not null check (price >= 0),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint products_name_tenant_unique unique (tenant_id, name)
);

-- 3) product_day_visibility (RF-05) — NORMALIZADA: isola pelo produto (pai)
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
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  client_id    uuid not null unique,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name         varchar(200) not null,
  address      text,
  contact_name varchar(200),
  phone        varchar(20),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint suppliers_name_tenant_unique unique (tenant_id, name)
);

-- 5) product_suppliers (N:N) — NORMALIZADA: isola pelo produto (pai)
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
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  client_id         uuid not null unique,
  product_client_id uuid not null unique references public.products (client_id) on delete restrict,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete restrict,
  quantity          numeric(10,3) not null default 0 check (quantity >= 0),
  alert_threshold   numeric(10,3) not null default 0, -- dispara alerta push (RF-11)
  updated_at        timestamptz not null default now()
);

-- 7) stock_entries (histórico de entradas) ---------------------------
create table if not exists public.stock_entries (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
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
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
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

-- 9) sale_items — NORMALIZADA: isola pela venda (pai) -----------------
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

-- 10) reports --------------------------------------------------------
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
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

-- 11) sync_checkpoints (robustez multi-device) -----------------------
create table if not exists public.sync_checkpoints (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_id      varchar(100) not null,
  table_name     varchar(100) not null,
  last_synced_at timestamptz not null default now(),
  constraint sync_checkpoints_unique unique (user_id, device_id, table_name)
);

-- =====================================================================
-- TRIGGERS de updated_at
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'tenants','categories','products','product_day_visibility','suppliers','product_suppliers',
    'stock_items','stock_entries','sales','sale_items','reports'
  ] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on public.%1$s
         for each row execute function public.update_updated_at_column();', t);
  end loop;
end $$;

-- =====================================================================
-- TRIGGERS de negócio (estoque) — agora propagam tenant_id
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

-- Incremento de estoque ao registrar entrada (RF-09) — herda tenant_id da entrada
create or replace function public.increment_stock_on_entry()
returns trigger language plpgsql as $$
begin
  insert into public.stock_items (tenant_id, client_id, product_client_id, user_id, quantity)
    values (new.tenant_id, gen_random_uuid(), new.product_client_id, new.user_id, new.quantity)
  on conflict (product_client_id)
    do update set quantity = public.stock_items.quantity + new.quantity, updated_at = now();
  return new;
end; $$;
drop trigger if exists trg_increment_stock_on_entry on public.stock_entries;
create trigger trg_increment_stock_on_entry
  after insert on public.stock_entries
  for each row execute function public.increment_stock_on_entry();

-- =====================================================================
-- ÍNDICES
--   • Tabelas com tenant_id direto: índice começa por tenant_id.
--   • Tabelas filhas (normalizadas): índice pela FK do pai (usada na RLS via EXISTS).
-- =====================================================================
create index if not exists idx_sales_tenant_date          on public.sales (tenant_id, sale_date desc);
create index if not exists idx_sales_tenant_payment        on public.sales (tenant_id, payment_method, sale_date);
create index if not exists idx_sales_not_synced            on public.sales (tenant_id, synced_at) where synced_at is null;
create index if not exists idx_sale_items_sale             on public.sale_items (sale_client_id);
create index if not exists idx_sale_items_product          on public.sale_items (product_client_id);
create index if not exists idx_stock_items_tenant          on public.stock_items (tenant_id);
create index if not exists idx_stock_items_alert           on public.stock_items (tenant_id, quantity, alert_threshold) where alert_threshold > 0;
create index if not exists idx_products_tenant_active       on public.products (tenant_id, is_active, category_client_id) where is_active = true;
create index if not exists idx_categories_tenant            on public.categories (tenant_id, display_order);
create index if not exists idx_suppliers_tenant             on public.suppliers (tenant_id);
create index if not exists idx_stock_entries_tenant         on public.stock_entries (tenant_id, entry_date desc);
create index if not exists idx_reports_tenant               on public.reports (tenant_id, created_at desc);
create index if not exists idx_product_suppliers_product    on public.product_suppliers (product_client_id, is_preferred);
-- product_day_visibility: a UNIQUE (product_client_id, day_of_week) já indexa a FK do pai.

-- =====================================================================
-- ROW LEVEL SECURITY — isolamento por EMPRESA (tenant_id)
-- =====================================================================

-- Habilita RLS em tudo
do $$
declare t text;
begin
  foreach t in array array[
    'tenants','tenant_members','categories','products','product_day_visibility','suppliers',
    'product_suppliers','stock_items','stock_entries','sales','sale_items','reports','sync_checkpoints'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- tenants: membro vê/edita a própria empresa; só owner altera dados cadastrais
drop policy if exists tenant_member_select on public.tenants;
create policy tenant_member_select on public.tenants for select to authenticated
  using (id in (select public.user_tenant_ids()));
drop policy if exists tenant_owner_write on public.tenants;
create policy tenant_owner_write on public.tenants for update to authenticated
  using (public.is_tenant_owner(id)) with check (public.is_tenant_owner(id));

-- tenant_members: membro enxerga a equipe da sua empresa; só owner gerencia a equipe
drop policy if exists members_select on public.tenant_members;
create policy members_select on public.tenant_members for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
drop policy if exists members_manage on public.tenant_members;
create policy members_manage on public.tenant_members for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));

-- Tabelas com tenant_id DIRETO: isolam por tenant_id.
-- Policy única "tenant_all": membro da empresa pode tudo dentro da empresa.
-- (Variante rápida via JWT — sem ler tabela — está comentada abaixo da função do hook.)
do $$
declare t text;
begin
  foreach t in array array[
    'categories','products','suppliers',
    'stock_items','stock_entries','sales','reports','sync_checkpoints'
  ] loop
    execute format('drop policy if exists tenant_all on public.%I;', t);
    execute format(
      'create policy tenant_all on public.%I for all to authenticated
         using (tenant_id in (select public.user_tenant_ids()))
         with check (tenant_id in (select public.user_tenant_ids()));', t);
  end loop;
end $$;

-- Tabelas FILHAS (normalizadas): RLS pelo tenant do registro PAI, via EXISTS.
-- Não têm tenant_id próprio; herdam o isolamento do produto/venda dono.
drop policy if exists tenant_all on public.product_day_visibility;
create policy tenant_all on public.product_day_visibility for all to authenticated
  using      (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and p.tenant_id in (select public.user_tenant_ids())))
  with check (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and p.tenant_id in (select public.user_tenant_ids())));

drop policy if exists tenant_all on public.product_suppliers;
create policy tenant_all on public.product_suppliers for all to authenticated
  using      (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and p.tenant_id in (select public.user_tenant_ids())))
  with check (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and p.tenant_id in (select public.user_tenant_ids())));

drop policy if exists tenant_all on public.sale_items;
create policy tenant_all on public.sale_items for all to authenticated
  using      (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())))
  with check (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())));

-- =====================================================================
-- Sugestão 3: CUSTOM ACCESS TOKEN HOOK — injeta tenant_ids no JWT
-- Habilitar em: Supabase Dashboard → Authentication → Hooks →
--   "Custom Access Token" → selecionar public.add_tenant_claims.
-- Depois de habilitado, as policies podem usar o caminho rápido (comentado)
-- que lê app_metadata.tenant_ids do JWT, sem tocar em tenant_members.
-- =====================================================================
create or replace function public.add_tenant_claims(event jsonb)
returns jsonb language plpgsql stable as $$
declare
  claims    jsonb;
  tenant_ids jsonb;
begin
  select coalesce(jsonb_agg(tm.tenant_id), '[]'::jsonb)
    into tenant_ids
    from public.tenant_members tm
   where tm.user_id = (event->>'user_id')::uuid;

  claims := event->'claims';
  if claims->'app_metadata' is null then
    claims := jsonb_set(claims, '{app_metadata}', '{}'::jsonb);
  end if;
  claims := jsonb_set(claims, '{app_metadata,tenant_ids}', tenant_ids);

  return jsonb_set(event, '{claims}', claims);
end; $$;

-- Permissões exigidas pelo Auth para executar o hook
grant usage on schema public to supabase_auth_admin;
grant execute on function public.add_tenant_claims(jsonb) to supabase_auth_admin;
revoke execute on function public.add_tenant_claims(jsonb) from authenticated, anon, public;
grant select on public.tenant_members to supabase_auth_admin;

-- VARIANTE RÁPIDA (opcional) — após habilitar o hook, dá pra trocar as policies por:
--   using (tenant_id = any (
--     select (jsonb_array_elements_text(auth.jwt() -> 'app_metadata' -> 'tenant_ids'))::uuid))
-- Evita o SELECT em tenant_members a cada query (mais barato no free tier).

-- =====================================================================
-- SEED + BOOTSTRAP
-- =====================================================================

-- (a) Ao criar a EMPRESA → semeia as 4 categorias padrão da empresa.
create or replace function public.seed_tenant_categories()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.categories (tenant_id, client_id, user_id, name, slug, display_order) values
    (new.id, gen_random_uuid(), new.owner_user_id, 'Churrasquinho', 'churrasquinho', 1),
    (new.id, gen_random_uuid(), new.owner_user_id, 'Bebidas',       'bebidas',       2),
    (new.id, gen_random_uuid(), new.owner_user_id, 'Lanches',       'lanches',       3),
    (new.id, gen_random_uuid(), new.owner_user_id, 'Especiais',     'especiais',     4)
  on conflict (tenant_id, name) do nothing;
  return new;
end; $$;
drop trigger if exists trg_seed_tenant_categories on public.tenants;
create trigger trg_seed_tenant_categories
  after insert on public.tenants
  for each row execute function public.seed_tenant_categories();

-- (b) Ao criar o USUÁRIO → cria a 1ª empresa dele + membership(owner) (bootstrap).
--     O nome pode vir do metadado 'business_name' (preenchido no cadastro).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
begin
  insert into public.tenants (name, owner_user_id)
    values (coalesce(nullif(new.raw_user_meta_data->>'business_name',''), 'Minha Empresa'), new.id)
    returning id into v_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant_id, new.id, 'owner')
  on conflict (tenant_id, user_id) do nothing;

  return new;
end; $$;
drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- STORAGE: bucket privado de relatórios, isolado por EMPRESA
-- Caminho: reports/<tenant_id>/arquivo.pdf  (escrita pela Edge Function)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

drop policy if exists reports_tenant_read on storage.objects;
create policy reports_tenant_read on storage.objects for select to authenticated
  using (
    bucket_id = 'reports'
    and ((storage.foldername(name))[1])::uuid in (select public.user_tenant_ids())
  );

-- =====================================================================
-- (OPCIONAL) SUGESTÃO 4 — DESNORMALIZAR tenant_id nas tabelas filhas
-- Aplicar SOMENTE se as filhas crescerem muito e a RLS via EXISTS virar gargalo.
-- Migração segura (rodar manualmente quando/se necessário):
--
--   alter table public.sale_items            add column tenant_id uuid references public.tenants(id);
--   alter table public.product_suppliers     add column tenant_id uuid references public.tenants(id);
--   alter table public.product_day_visibility add column tenant_id uuid references public.tenants(id);
--
--   -- backfill a partir do pai
--   update public.sale_items si set tenant_id = s.tenant_id
--     from public.sales s where s.client_id = si.sale_client_id;
--   update public.product_suppliers ps set tenant_id = p.tenant_id
--     from public.products p where p.client_id = ps.product_client_id;
--   update public.product_day_visibility pdv set tenant_id = p.tenant_id
--     from public.products p where p.client_id = pdv.product_client_id;
--
--   alter table public.sale_items             alter column tenant_id set not null;
--   alter table public.product_suppliers      alter column tenant_id set not null;
--   alter table public.product_day_visibility alter column tenant_id set not null;
--
--   -- (consistência) FK composta garante que a filha não troque de empresa:
--   --   exige UNIQUE(tenant_id, client_id) no pai; depois:
--   --   alter table public.sale_items add constraint sale_items_tenant_sale_fk
--   --     foreign key (tenant_id, sale_client_id) references public.sales (tenant_id, client_id);
--
--   -- então trocar as policies EXISTS pela forma direta:
--   --   using (tenant_id in (select public.user_tenant_ids()))
--   -- e criar índices: idx_sale_items_tenant (tenant_id), etc.
-- =====================================================================

-- =====================================================================
-- FIM — VERSÃO SAAS MULTI-TENANT (Sugestões 1 + 3; filhas NORMALIZADAS)
--
-- CHECKLIST PÓS-DEPLOY:
--   1) Habilitar o Custom Access Token Hook (add_tenant_claims) no Dashboard.
--   2) No cadastro, enviar metadado 'business_name' para nomear a 1ª empresa.
--   3) App: enviar tenant_id em TODA escrita das tabelas com tenant_id direto
--      (categories, products, suppliers, stock_*, sales, reports). As filhas
--      (sale_items, product_suppliers, product_day_visibility) herdam do pai.
--   4) Convidar funcionários = inserir em tenant_members (somente owner).
--   5) Testar isolamento: usuário do tenant X não deve ler linhas do tenant Y.
--
-- LIMITES DO FREE TIER (relevantes p/ multi-cliente):
--   • ~500 MB de banco e ~1 GB de Storage — monitorar com histórico de vendas.
--   • Projeto free pausa após ~7 dias sem atividade — p/ clientes reais avaliar plano Pro.
--   • Sem isolamento físico entre empresas: segurança depende 100% da RLS — testar policies.
-- =====================================================================
