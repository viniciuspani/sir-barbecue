-- =====================================================================
-- Sir Barbecue — RBAC: RLS por papel (owner / manager / employee).
--
-- Motivo: hoje a política `tenant_all` libera TUDO para qualquer membro do
-- tenant. Passamos a distinguir papéis: LEITURA continua liberada a todos os
-- membros (o caixa precisa ler produtos/estoque para vender); a ESCRITA passa
-- a depender do papel:
--   • suppliers / product_suppliers ....... escreve só OWNER
--   • products / categories / stock_* ..... escreve OWNER ou MANAGER
--   • reports (ler e gerar) ............... só OWNER ou MANAGER
--   • sales / sale_items / sync_checkpoints  todos os membros (todos vendem)
--
-- Padrão: policy FOR SELECT (membros) + policy FOR ALL (papel) — permissivas
-- são OR, então leitura passa pela SELECT e escrita é governada pela FOR ALL.
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run. Idempotente.
-- =====================================================================

begin;

-- Helper: o usuário logado é OWNER ou MANAGER da empresa? (base da escrita de catálogo)
create or replace function public.is_tenant_owner_or_manager(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id and tm.user_id = auth.uid()
      and tm.role in ('owner','manager')
  );
$$;

-- ---------------------------------------------------------------------
-- CATÁLOGO/ESTOQUE (tenant_id direto): leitura membros, escrita owner|manager
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['categories','products','stock_items','stock_entries'] loop
    execute format('drop policy if exists tenant_all on public.%I;', t);
    execute format('drop policy if exists %1$s_select on public.%1$s;', t);
    execute format('drop policy if exists %1$s_write on public.%1$s;', t);
    execute format(
      'create policy %1$s_select on public.%1$s for select to authenticated
         using (tenant_id in (select public.user_tenant_ids()));', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all to authenticated
         using (public.is_tenant_owner_or_manager(tenant_id))
         with check (public.is_tenant_owner_or_manager(tenant_id));', t);
  end loop;
end $$;

-- product_day_visibility (filha do produto): idem catálogo, via EXISTS no pai
drop policy if exists tenant_all on public.product_day_visibility;
drop policy if exists pdv_select on public.product_day_visibility;
drop policy if exists pdv_write on public.product_day_visibility;
create policy pdv_select on public.product_day_visibility for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and p.tenant_id in (select public.user_tenant_ids())));
create policy pdv_write on public.product_day_visibility for all to authenticated
  using      (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner_or_manager(p.tenant_id)))
  with check (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner_or_manager(p.tenant_id)));

-- ---------------------------------------------------------------------
-- FORNECEDOR: leitura membros, escrita SÓ OWNER
-- ---------------------------------------------------------------------
drop policy if exists tenant_all on public.suppliers;
drop policy if exists suppliers_select on public.suppliers;
drop policy if exists suppliers_write on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
create policy suppliers_write on public.suppliers for all to authenticated
  using (public.is_tenant_owner(tenant_id))
  with check (public.is_tenant_owner(tenant_id));

-- product_suppliers (filha do produto): leitura membros, escrita só owner
drop policy if exists tenant_all on public.product_suppliers;
drop policy if exists product_suppliers_select on public.product_suppliers;
drop policy if exists product_suppliers_write on public.product_suppliers;
create policy product_suppliers_select on public.product_suppliers for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and p.tenant_id in (select public.user_tenant_ids())));
create policy product_suppliers_write on public.product_suppliers for all to authenticated
  using      (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner(p.tenant_id)))
  with check (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner(p.tenant_id)));

-- ---------------------------------------------------------------------
-- RELATÓRIOS: só owner|manager leem e geram (dados financeiros)
-- ---------------------------------------------------------------------
drop policy if exists tenant_all on public.reports;
drop policy if exists reports_access on public.reports;
create policy reports_access on public.reports for all to authenticated
  using (public.is_tenant_owner_or_manager(tenant_id))
  with check (public.is_tenant_owner_or_manager(tenant_id));

-- Storage: leitura dos arquivos de relatório restrita a owner|manager do tenant.
drop policy if exists reports_tenant_read on storage.objects;
create policy reports_tenant_read on storage.objects for select to authenticated
  using (
    bucket_id = 'reports'
    and public.is_tenant_owner_or_manager(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------
-- VENDAS + sync_checkpoints: leitura+escrita a TODOS os membros (todos vendem).
-- (sales / sale_items / sync_checkpoints mantêm tenant_all — sem mudança aqui.)
-- product_supplier_price_history mantém SELECT-only p/ membros (trigger escreve).
-- ---------------------------------------------------------------------

commit;

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente, autenticado como cada papel)
-- =====================================================================
-- -- como employee: deve FALHAR (0 linhas afetadas / erro de RLS):
-- update public.products set name = name where tenant_id = '<TID>';
-- insert into public.product_suppliers (client_id, product_client_id, supplier_client_id, purchase_price)
--   values (gen_random_uuid(), '<prod>', '<sup>', 1);
-- -- como employee: deve FUNCIONAR (leitura):
-- select count(*) from public.products;
-- -- como manager: products/stock OK; product_suppliers deve FALHAR; reports OK.
-- -- como owner: tudo OK.
-- =====================================================================
