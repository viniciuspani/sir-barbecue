-- =====================================================================
-- MIGRATION 14 — Trilha de auditoria de eventos sensíveis
-- Correção do achado A09-01 (Auditoria OWASP 2025, docs/auditoria-seguranca-web).
-- Aplica SOBRE o schema multi-tenant + licenciamento. Idempotente.
--
-- PROBLEMA:
--   Existe `error_logs` (erro técnico) e `health_events` (queda de infra), mas
--   nenhum registro de QUEM fez o quê. Todos os cenários de fraude interna do
--   relatório têm o mesmo agravante: se acontecerem, não há como descobrir o
--   responsável. As colunas `user_id` das tabelas de negócio guardam quem CRIOU
--   a linha — mas um DELETE leva a linha e o user_id junto. O dono não consegue
--   responder "quem apagou a venda de sexta?", e o operador da plataforma não
--   consegue investigar um cliente que alega vazamento.
--
-- DECISÕES:
--   • Append-only de verdade: o cliente não tem policy de INSERT, UPDATE nem
--     DELETE. Quem escreve são as triggers, SECURITY DEFINER. Sem policy de
--     escrita, a RLS nega por padrão — nem o owner adultera a própria trilha.
--   • `tenant_id` SEM foreign key para `tenants`, de propósito: com FK + cascade,
--     apagar a empresa apagaria justamente o registro de que ela foi apagada.
--   • Guarda anti-enxurrada: quando a empresa inteira é excluída, o cascade
--     dispara o DELETE de milhares de vendas. As triggers de linha detectam que
--     o tenant já não existe e não registram uma por uma — o evento
--     'tenant.delete' sozinho já conta a história.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Tabela
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id         bigserial primary key,
  tenant_id  uuid,                                   -- sem FK: ver decisões
  actor_id   uuid,                                   -- auth.uid() no momento do evento
  action     text not null,                          -- 'sale.delete', 'member.role_change', ...
  target     text,                                   -- id do objeto afetado (client_id/uuid)
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

create index if not exists idx_audit_log_tenant on public.audit_log (tenant_id, at desc);
create index if not exists idx_audit_log_action on public.audit_log (action, at desc);

-- ---------------------------------------------------------------------
-- 2) RLS — leitura para o owner da empresa e para o super-admin; escrita: ninguém
-- ---------------------------------------------------------------------
alter table public.audit_log enable row level security;

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (
    public.is_platform_admin()
    or (tenant_id is not null and public.is_tenant_owner(tenant_id))
  );
-- Nenhuma policy de INSERT/UPDATE/DELETE: com RLS ligada, isso é negação total
-- para qualquer cliente. As triggers abaixo são SECURITY DEFINER e não passam
-- pela RLS.

-- ---------------------------------------------------------------------
-- 3) Helper de gravação
-- ---------------------------------------------------------------------
create or replace function public.audit_write(
  p_tenant uuid,
  p_action text,
  p_target text,
  p_before jsonb default null,
  p_after  jsonb default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_log (tenant_id, actor_id, action, target, before, after)
  values (p_tenant, auth.uid(), p_action, p_target, p_before, p_after);
$$;

revoke all on function public.audit_write(uuid, text, text, jsonb, jsonb) from public;
-- Sem grant para `authenticated`: só as triggers (que rodam como o dono da
-- função) chamam este helper. O cliente não escreve na trilha.

-- true quando a empresa já não existe = estamos dentro do cascade de
-- 'tenant.delete' e não vale registrar linha por linha.
create or replace function public.audit_tenant_alive(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.tenants where id = p_tenant);
$$;

-- ---------------------------------------------------------------------
-- 4) VENDAS — exclusão e alteração de valor
-- ---------------------------------------------------------------------
-- É o par de eventos que denuncia a sangria de caixa: apagar a venda depois de
-- receber, ou baixar o total já registrado.
create or replace function public.audit_sale_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.audit_tenant_alive(old.tenant_id) then
    perform public.audit_write(
      old.tenant_id, 'sale.delete', old.client_id::text, to_jsonb(old), null);
  end if;
  return old;
end; $$;

drop trigger if exists trg_audit_sale_delete on public.sales;
create trigger trg_audit_sale_delete
  before delete on public.sales
  for each row execute function public.audit_sale_delete();

create or replace function public.audit_sale_amount_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.total_amount is distinct from old.total_amount then
    perform public.audit_write(
      old.tenant_id, 'sale.amount_change', old.client_id::text,
      jsonb_build_object('total_amount', old.total_amount),
      jsonb_build_object('total_amount', new.total_amount));
  end if;
  return new;
end; $$;

drop trigger if exists trg_audit_sale_amount on public.sales;
create trigger trg_audit_sale_amount
  after update of total_amount on public.sales
  for each row execute function public.audit_sale_amount_update();

-- ---------------------------------------------------------------------
-- 5) EQUIPE — remoção de membro e mudança de papel
-- ---------------------------------------------------------------------
create or replace function public.audit_member_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.audit_tenant_alive(old.tenant_id) then
    perform public.audit_write(
      old.tenant_id, 'member.remove', old.user_id::text,
      jsonb_build_object('user_id', old.user_id, 'role', old.role), null);
  end if;
  return old;
end; $$;

drop trigger if exists trg_audit_member_delete on public.tenant_members;
create trigger trg_audit_member_delete
  before delete on public.tenant_members
  for each row execute function public.audit_member_delete();

create or replace function public.audit_member_role_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    perform public.audit_write(
      old.tenant_id, 'member.role_change', old.user_id::text,
      jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
  end if;
  return new;
end; $$;

drop trigger if exists trg_audit_member_role on public.tenant_members;
create trigger trg_audit_member_role
  after update of role on public.tenant_members
  for each row execute function public.audit_member_role_update();

-- ---------------------------------------------------------------------
-- 6) EMPRESA — exclusão (o evento irreversível)
-- ---------------------------------------------------------------------
create or replace function public.audit_tenant_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.audit_write(
    old.id, 'tenant.delete', old.id::text,
    jsonb_build_object('name', old.name, 'owner_user_id', old.owner_user_id), null);
  return old;
end; $$;

drop trigger if exists trg_audit_tenant_delete on public.tenants;
create trigger trg_audit_tenant_delete
  before delete on public.tenants
  for each row execute function public.audit_tenant_delete();

-- ---------------------------------------------------------------------
-- 7) PREÇO DE VENDA do produto
-- ---------------------------------------------------------------------
-- O custo de compra já tem histórico próprio (trg_log_price_history). O preço de
-- VENDA não tinha rastro nenhum.
create or replace function public.audit_product_price_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.price is distinct from old.price then
    perform public.audit_write(
      old.tenant_id, 'product.price_change', old.client_id::text,
      jsonb_build_object('name', old.name, 'price', old.price),
      jsonb_build_object('price', new.price));
  end if;
  return new;
end; $$;

drop trigger if exists trg_audit_product_price on public.products;
create trigger trg_audit_product_price
  after update of price on public.products
  for each row execute function public.audit_product_price_update();

-- ---------------------------------------------------------------------
-- 8) DIVERGÊNCIA DE PREÇO NA VENDA — controle compensatório do caminho mobile
-- ---------------------------------------------------------------------
-- A MIGRATION_12 bloqueia preço adulterado na RPC `create_sale` (caminho do
-- PWA). O app Android não passa por ela: é offline-first e sobe a venda pelo
-- upsert do sync. Nesse caminho não dá para BLOQUEAR por divergência — uma venda
-- feita há três dias e sincronizada hoje legitimamente carrega o preço de três
-- dias atrás. Então aqui só se REGISTRA, para o dono ter o que revisar.
--
-- Se o volume incomodar (empresa que muda preço toda semana), este é o único
-- trigger desta migração seguro de desligar:
--   drop trigger trg_audit_sale_item_price on public.sale_items;
create or replace function public.audit_sale_item_price_divergence()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_price  numeric(10,2);
  v_tenant uuid;
  v_name   text;
begin
  select p.price, p.tenant_id, p.name into v_price, v_tenant, v_name
    from public.products p
   where p.client_id = new.product_client_id;

  if v_price is not null and abs(new.unit_price - v_price) > 0.01 then
    perform public.audit_write(
      v_tenant, 'sale_item.price_divergence', new.sale_client_id::text,
      jsonb_build_object('product', v_name, 'cadastro', v_price),
      jsonb_build_object('cobrado', new.unit_price, 'quantidade', new.quantity));
  end if;
  return new;
end; $$;

drop trigger if exists trg_audit_sale_item_price on public.sale_items;
create trigger trg_audit_sale_item_price
  after insert on public.sale_items
  for each row execute function public.audit_sale_item_price_divergence();

-- ---------------------------------------------------------------------
-- Verificação
-- ---------------------------------------------------------------------
-- Últimos eventos da empresa (como owner, pelo app ou pelo SQL Editor):
--   select at, action, target, before, after
--     from public.audit_log
--    where tenant_id = '<id>'
--    order by at desc limit 50;
--
-- Ninguém consegue escrever pelo cliente (deve dar 0 linhas / erro de RLS):
--   insert into public.audit_log (tenant_id, action) values ('<id>', 'teste');
