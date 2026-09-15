-- =====================================================================
-- MIGRATION 22 — Infra para exportação de dados da empresa (LGPD/portabilidade)
-- Aplica SOBRE SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql + MIGRATION_21_actor_tenant_members.sql
-- + docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql. Idempotente.
-- Plano completo: docs/exportacao-dados/PLANO_EXPORTACAO_DADOS.md
--
-- PROBLEMA:
--   A decisão de manter a LEITURA aberta mesmo pra empresa inadimplente
--   (MIGRATION_11, achado A06-01) foi justificada por "o cliente inadimplente
--   precisa conseguir consultar e exportar os próprios dados (LGPD e suporte)".
--   Essa exportação nunca existiu de fato — só o relatório HTML agregado
--   (generate-report), que não é um dump dos dados brutos.
--
-- O QUE ESTA MIGRAÇÃO CRIA (infra de banco; a Edge Function vem depois):
--   1) Tabela `data_exports` — rastreia cada exportação gerada (mesmo espírito
--      de `reports`, mas em tabela própria: `reports.type` tem CHECK fechado em
--      4 valores de relatório analítico, e semanticamente é outra coisa — dump
--      bruto vs. relatório agregado).
--   2) Bucket `exports` — igual `reports`, mas a policy de leitura é SÓ OWNER
--      (não owner|manager): o zip carrega custo de fornecedor e histórico de
--      cobrança da assinatura, dado mais sensível que o relatório de vendas.
--   3) Nova policy de SELECT em `payments` para o owner ler o PRÓPRIO histórico
--      de cobrança — hoje só existe `payments_admin_all` (super-admin), então
--      um owner comum lê zero linhas. Policies permissivas se somam com OR
--      (mesmo padrão da MIGRATION_11): a policy de admin continua intacta.
--   4) `delete_tenant_cascade` passa a apagar `data_exports` explicitamente,
--      pela MESMA razão da MIGRATION_21 com `reports`: a tabela referencia
--      `tenant_members`, que também cascateia de `tenants` no mesmo delete —
--      deixar pro cascade implícito é a armadilha que derrubou a MIGRATION_18.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) Tabela data_exports
-- ---------------------------------------------------------------------
create table if not exists public.data_exports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  client_id     uuid not null unique,
  user_id       uuid not null default auth.uid(),
  status        varchar(20) not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  parameters    jsonb not null default '{}',
  zip_url       text,
  error_message text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists idx_data_exports_tenant on public.data_exports (tenant_id, created_at desc);

-- Autoria aponta para o VÍNCULO, não para auth.users (mesmo raciocínio da
-- MIGRATION_21: a trilha de quem gerou o export sobrevive à saída da pessoa).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.data_exports'::regclass
       and conname = 'data_exports_actor_fkey'
  ) then
    alter table public.data_exports add constraint data_exports_actor_fkey
      foreign key (tenant_id, user_id)
      references public.tenant_members (tenant_id, user_id) on delete no action;
  end if;
end $$;

alter table public.data_exports enable row level security;

-- Owner-only: mais restrito que `reports_access` (owner|manager) porque o zip
-- inclui custo de fornecedor e histórico de cobrança da assinatura.
drop policy if exists data_exports_owner_access on public.data_exports;
create policy data_exports_owner_access on public.data_exports for all to authenticated
  using (public.is_tenant_owner(tenant_id))
  with check (public.is_tenant_owner(tenant_id));

-- ---------------------------------------------------------------------
-- 2) STORAGE: bucket privado de exportações, isolado por EMPRESA
-- Caminho: exports/<tenant_id>/<export_id>.zip (escrita só pela Edge Function,
-- via service_role — igual `reports`, sem policy de INSERT pro cliente).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;

drop policy if exists exports_tenant_owner_read on storage.objects;
create policy exports_tenant_owner_read on storage.objects for select to authenticated
  using (
    bucket_id = 'exports'
    and public.is_tenant_owner(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------
-- 3) payments: owner passa a ler o PRÓPRIO histórico de cobrança
-- Aditiva — NÃO substitui payments_admin_all (permissivas se somam com OR).
-- ---------------------------------------------------------------------
drop policy if exists payments_tenant_owner_read on public.payments;
create policy payments_tenant_owner_read on public.payments for select to authenticated
  using (
    tenant_id in (select public.user_tenant_ids())
    and public.is_tenant_owner(tenant_id)
  );

-- ---------------------------------------------------------------------
-- 4) delete_tenant_cascade — apagar data_exports ANTES da empresa
-- Mesma função da MIGRATION_21, só acrescentando a linha nova (passo 6).
-- ---------------------------------------------------------------------
create or replace function public.delete_tenant_cascade(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) Itens de venda e de comanda.
  delete from public.sale_items si
   using public.sales s
   where s.client_id = si.sale_client_id and s.tenant_id = p_tenant_id;

  delete from public.tab_items ti
   using public.tabs t
   where t.client_id = ti.tab_client_id and t.tenant_id = p_tenant_id;

  -- 2) Filhas diretas de products / suppliers.
  delete from public.product_day_visibility pdv
   using public.products pr
   where pr.client_id = pdv.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_supplier_price_history h
   using public.products pr
   where pr.client_id = h.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.products pr
   where pr.client_id = ps.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.suppliers su
   where su.client_id = ps.supplier_client_id and su.tenant_id = p_tenant_id;

  -- 3) Tabelas com tenant_id que apontam para products/suppliers.
  delete from public.stock_items   where tenant_id = p_tenant_id;
  delete from public.stock_entries where tenant_id = p_tenant_id;

  -- 4) Vendas e comandas.
  delete from public.sales where tenant_id = p_tenant_id;
  delete from public.tabs  where tenant_id = p_tenant_id;

  -- 5) Catálogo.
  delete from public.products   where tenant_id = p_tenant_id;
  delete from public.suppliers  where tenant_id = p_tenant_id;
  delete from public.categories where tenant_id = p_tenant_id;

  -- 6) Relatórios e exportações ANTES da empresa. Ambos referenciam
  --    tenant_members, que cascateia de tenants no mesmo delete — deixar
  --    para o cascade seria apostar na ordem da fila de triggers (MIGRATION_18).
  delete from public.reports      where tenant_id = p_tenant_id;
  delete from public.data_exports where tenant_id = p_tenant_id;

  -- 7) O resto (sync_checkpoints, tenant_members, tenant_invites, error_logs,
  --    subscriptions, tenant_devices, payments) cascateia de tenants, e nada
  --    mais aponta para eles.
  delete from public.tenants where id = p_tenant_id;
end;
$$;

revoke execute on function public.delete_tenant_cascade(uuid) from public, anon, authenticated;

commit;

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO
-- =====================================================================
-- 1) Tabela e policy existem?
--    select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public' and tablename in ('data_exports');
--
--    select tablename, policyname, cmd from pg_policies
--     where schemaname = 'storage' and tablename = 'objects' and policyname = 'exports_tenant_owner_read';
--
-- 2) payments ganhou a policy nova sem perder a do admin?
--    select policyname, cmd, roles from pg_policies
--     where schemaname = 'public' and tablename = 'payments';
--    -- deve listar payments_admin_all E payments_tenant_owner_read.
--
-- 3) TESTE FUNCIONAL (obrigatório — mesmo método usado para a MIGRATION_11:
--    autenticar via API com o token de um owner real, NÃO pelo SQL Editor,
--    que roda como `postgres` e pula a RLS):
--    GET .../rest/v1/payments?tenant_id=eq.<id>  -- com o token do OWNER do tenant
--      -> deve retornar as linhas do próprio tenant (hoje retorna vazio).
--    GET .../rest/v1/payments?tenant_id=eq.<id>  -- com o token de um EMPLOYEE do mesmo tenant
--      -> deve continuar retornando vazio (só owner).
--
-- 4) bucket `exports` existe e está privado?
--    select id, name, public from storage.buckets where id = 'exports';
-- =====================================================================
