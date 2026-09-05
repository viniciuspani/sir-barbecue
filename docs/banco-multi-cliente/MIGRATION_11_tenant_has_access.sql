-- =====================================================================
-- MIGRATION 11 — Assinatura passa a valer NO SERVIDOR (não só na tela)
-- Correção do achado A06-01 (Auditoria OWASP 2025, docs/auditoria-seguranca-web).
-- Aplica SOBRE SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql + MIGRATION_09_tabs.sql
-- + docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql. Idempotente.
--
-- PROBLEMA:
--   `get_access_status` avalia a assinatura corretamente e com a hora do
--   servidor, mas apenas INFORMA — quem bloqueia é a UI (RequireAccess no web,
--   access.ts no mobile). Nenhuma policy consultava `subscriptions`. Uma empresa
--   com trial vencido, inadimplente ou desligada pelo dono (`blocked_by_owner`)
--   continuava vendendo normalmente pela API:
--
--     curl -X POST ".../rest/v1/rpc/create_sale" -H "apikey: <anon>" \
--          -H "Authorization: Bearer <token do usuário bloqueado>" -d '{...}'
--
--   Ou seja: o kill switch do dono não desligava nada e a cobrança era burlável
--   sem nem precisar editar o app.
--
-- DECISÕES:
--   • Só a ESCRITA é bloqueada. A LEITURA continua liberada para todos os
--     membros mesmo com a assinatura vencida — o cliente inadimplente precisa
--     conseguir consultar e exportar os próprios dados (LGPD e suporte), e
--     bloquear leitura transformaria um problema de cobrança em retenção de
--     dado alheio.
--   • A visibilidade de `sales` NÃO muda: a policy de SELECT continua liberada a
--     todo membro da empresa, exatamente como hoje. O que a migração faz é
--     separar a policy única `tenant_all` (que valia para tudo) em uma de
--     leitura — idêntica à regra atual — e uma de escrita, esta sim exigindo
--     assinatura ativa.
--   • `sync_checkpoints` fica de fora do bloqueio de propósito: é bookkeeping do
--     sync. Travá-lo impediria o aparelho de sequer terminar um ciclo de leitura.
--   • `tenant_has_access` é `stable` + `security definer`: é avaliada por linha
--     dentro das policies, e `subscriptions` tem unique(tenant_id), então a busca
--     é por índice. DEFINER evita depender da RLS de `subscriptions` dentro de
--     outra policy.
--
-- ATENÇÃO — AFETA O APP ANDROID:
--   O mobile é offline-first: vendas registradas offline sobem depois pelo push
--   do sync. Se a assinatura vencer enquanto houver venda pendente, o push
--   passará a falhar (as linhas ficam retidas no SQLite local até a
--   regularização). Isso é o comportamento desejado — mas valide antes em um
--   tenant de teste com `trial_ends_at` no passado, com os DOIS clientes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) A função de veredito — mesma regra da get_access_status
-- ---------------------------------------------------------------------
-- Espelha SUPABASE_SCHEMA_LICENSING.sql (get_access_status):
--   • blocked_by_owner  -> sem acesso (kill switch do dono)
--   • canceled/past_due -> sem acesso
--   • trial             -> acesso enquanto now() < trial_ends_at (null = sem prazo)
--   • active            -> acesso até current_period_end + 48h de carência
--   • sem linha em subscriptions -> sem acesso (mesmo 'no_subscription' da RPC)
-- Qualquer mudança de regra precisa ser feita NOS DOIS lugares.
create or replace function public.tenant_has_access(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.subscriptions s
     where s.tenant_id = p_tenant_id
       and s.blocked_by_owner = false
       and (
            (s.status = 'trial'
             and (s.trial_ends_at is null or now() < s.trial_ends_at))
         or (s.status = 'active'
             and (s.current_period_end is null
                  or now() < s.current_period_end + interval '48 hours'))
       )
  );
$$;

comment on function public.tenant_has_access(uuid) is
  'true = a empresa pode ESCREVER agora (assinatura ativa/trial válido e não bloqueada pelo dono). Mesma regra de get_access_status; usada nas policies de escrita.';

revoke all on function public.tenant_has_access(uuid) from public;
grant execute on function public.tenant_has_access(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2) VENDAS — leitura inalterada, escrita exige assinatura
-- ---------------------------------------------------------------------
-- A policy `tenant_all` (for all) é substituída por duas. Policies permissivas
-- se somam com OR, então o SELECT continua atendido por sales_select mesmo
-- quando sales_write nega — que é exatamente o que queremos.
drop policy if exists tenant_all on public.sales;
drop policy if exists sales_select on public.sales;
drop policy if exists sales_write on public.sales;

create policy sales_select on public.sales for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));

create policy sales_write on public.sales for all to authenticated
  using      (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id))
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id));

-- sale_items: isola pela venda-pai (mesmo padrão do schema base).
drop policy if exists tenant_all on public.sale_items;
drop policy if exists sale_items_select on public.sale_items;
drop policy if exists sale_items_write on public.sale_items;

create policy sale_items_select on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s
                 where s.client_id = sale_client_id
                   and s.tenant_id in (select public.user_tenant_ids())));

create policy sale_items_write on public.sale_items for all to authenticated
  using      (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(s.tenant_id)))
  with check (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(s.tenant_id)));

-- ---------------------------------------------------------------------
-- 3) COMANDAS — mesma separação
-- ---------------------------------------------------------------------
drop policy if exists tenant_all on public.tabs;
drop policy if exists tabs_select on public.tabs;
drop policy if exists tabs_write on public.tabs;

create policy tabs_select on public.tabs for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));

create policy tabs_write on public.tabs for all to authenticated
  using      (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id))
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id));

drop policy if exists tenant_all on public.tab_items;
drop policy if exists tab_items_select on public.tab_items;
drop policy if exists tab_items_write on public.tab_items;

create policy tab_items_select on public.tab_items for select to authenticated
  using (exists (select 1 from public.tabs t
                 where t.client_id = tab_client_id
                   and t.tenant_id in (select public.user_tenant_ids())));

create policy tab_items_write on public.tab_items for all to authenticated
  using      (exists (select 1 from public.tabs t
                      where t.client_id = tab_client_id
                        and t.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(t.tenant_id)))
  with check (exists (select 1 from public.tabs t
                      where t.client_id = tab_client_id
                        and t.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(t.tenant_id)));

-- ---------------------------------------------------------------------
-- 4) CATÁLOGO E ESTOQUE — a escrita (owner|manager) passa a exigir assinatura
-- ---------------------------------------------------------------------
-- Recria apenas as policies `_write`; as `_select` do schema base ficam intactas.
do $$
declare t text;
begin
  foreach t in array array['categories','products','stock_items','stock_entries'] loop
    execute format('drop policy if exists %1$s_write on public.%1$s;', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all to authenticated
         using      (public.is_tenant_owner_or_manager(tenant_id)
                     and public.tenant_has_access(tenant_id))
         with check (public.is_tenant_owner_or_manager(tenant_id)
                     and public.tenant_has_access(tenant_id));', t);
  end loop;
end $$;

-- product_day_visibility (filha do produto)
drop policy if exists pdv_write on public.product_day_visibility;
create policy pdv_write on public.product_day_visibility for all to authenticated
  using      (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner_or_manager(p.tenant_id)
                        and public.tenant_has_access(p.tenant_id)))
  with check (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner_or_manager(p.tenant_id)
                        and public.tenant_has_access(p.tenant_id)));

-- FORNECEDOR (escrita só owner) + vínculo produto-fornecedor
drop policy if exists suppliers_write on public.suppliers;
create policy suppliers_write on public.suppliers for all to authenticated
  using      (public.is_tenant_owner(tenant_id) and public.tenant_has_access(tenant_id))
  with check (public.is_tenant_owner(tenant_id) and public.tenant_has_access(tenant_id));

drop policy if exists product_suppliers_write on public.product_suppliers;
create policy product_suppliers_write on public.product_suppliers for all to authenticated
  using      (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner(p.tenant_id)
                        and public.tenant_has_access(p.tenant_id)))
  with check (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner(p.tenant_id)
                        and public.tenant_has_access(p.tenant_id)));

-- ---------------------------------------------------------------------
-- Verificação
-- ---------------------------------------------------------------------
-- 1) A empresa tem acesso agora?
--    select t.name, public.tenant_has_access(t.id) from public.tenants t order by 1;
--
-- 2) Toda empresa tem linha em subscriptions? (sem linha = escrita bloqueada)
--    select t.id, t.name from public.tenants t
--     where not exists (select 1 from public.subscriptions s where s.tenant_id = t.id);
--
-- 3) As policies novas existem?
--    select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public'
--       and tablename in ('sales','sale_items','tabs','tab_items','products',
--                         'categories','stock_items','stock_entries','suppliers',
--                         'product_suppliers','product_day_visibility')
--     order by tablename, policyname;
--
-- TESTE FUNCIONAL (obrigatório antes de considerar aplicada):
--   a) num tenant de teste, `update public.subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = '<id>';`
--   b) tentar vender pelo PWA e pelo Android -> a venda deve FALHAR;
--   c) conferir que as telas de consulta e o relatório continuam abrindo;
--   d) restaurar o trial_ends_at.
