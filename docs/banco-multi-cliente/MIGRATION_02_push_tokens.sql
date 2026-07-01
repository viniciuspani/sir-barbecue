-- =====================================================================
-- MIGRATION 02 — Infra de push (RF-11 estoque baixo)
-- Aplica SOBRE o schema multi-tenant já implantado. Idempotente. Rode no SQL Editor.
--
--  • Tabela push_tokens (token do device por usuário/empresa) + RLS por tenant.
--  • Trigger notify_low_stock: ao ficar com estoque baixo, dispara push para os
--    devices da empresa, chamando a Expo Push API direto via pg_net (endpoint público,
--    sem segredo no banco).
-- =====================================================================

create extension if not exists pg_net;

-- ---------------------------------------------------------------------
create table if not exists public.push_tokens (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token      text not null,
  platform   varchar(10),
  updated_at timestamptz not null default now(),
  constraint push_tokens_unique unique (user_id, token)
);

alter table public.push_tokens enable row level security;
drop policy if exists tenant_all on public.push_tokens;
create policy tenant_all on public.push_tokens
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

create index if not exists idx_push_tokens_tenant on public.push_tokens (tenant_id);

-- ---------------------------------------------------------------------
-- RF-11: ao baixar para <= alert_threshold, notifica os devices da empresa.
create or replace function public.notify_low_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  r record;
begin
  if new.alert_threshold > 0
     and new.quantity <= new.alert_threshold
     and new.quantity < old.quantity then

    select name into v_name from public.products where client_id = new.product_client_id;

    for r in select token from public.push_tokens where tenant_id = new.tenant_id loop
      perform net.http_post(
        url     := 'https://exp.host/--/api/v2/push/send',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body    := jsonb_build_object(
          'to',    r.token,
          'sound', 'default',
          'title', 'Estoque baixo',
          'body',  coalesce(v_name, 'Um produto') || ' está acabando (' || new.quantity || ' restante).'
        )
      );
    end loop;
  end if;
  return new;
end; $$;

drop trigger if exists trg_notify_low_stock on public.stock_items;
create trigger trg_notify_low_stock
  after update on public.stock_items
  for each row execute function public.notify_low_stock();
