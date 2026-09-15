-- =====================================================================
-- MIGRATION 23 — Fecha 3 gaps residuais de IDOR/BOLA em tabelas filhas
-- Aplica SOBRE MIGRATION_11_tenant_has_access.sql + MIGRATION_13_supplier_cost_rbac.sql.
-- Idempotente. Achado em docs/auditoria-seguranca-web/AUDITORIA_BOLA_DOS_LOGS_2026-09.md
-- (seção 1 — "GAP real, impacto BAIXO").
--
-- PROBLEMA:
--   Quando uma linha referencia DOIS objetos de negócio por client_id (ex.:
--   comanda+produto; entrada de estoque+fornecedor; vínculo produto+fornecedor),
--   as policies de escrita validavam a posse de só UM dos lados. O outro
--   `..._client_id` era aceito sem checar se pertence ao MESMO tenant — como
--   todo client_id é único GLOBALMENTE (não por empresa), nada no banco
--   impedia uma linha filha cruzar tenants nesse segundo campo.
--
--   Já eram protegidas por TRIGGER (não por RLS), e continuam sem mudança
--   aqui: `sale_items.product_client_id` (deduct_stock_on_sale) e
--   `stock_entries.product_client_id` (increment_stock_on_entry) — ver
--   MIGRATION_03_stock_triggers_tenant_scope.sql.
--
-- IMPACTO REAL (documentado na auditoria, não é exploração nova):
--   Nenhuma das 3 combinações vaza dado de outra empresa (leitura de
--   suppliers/products já é isolada por tenant) nem move dinheiro/estoque —
--   o pior caso é uma referência cruzada "pendurada" poluindo comanda/entrada/
--   histórico de custo. Por isso ficou como prioridade baixa, mas o `exists`
--   a mais custa pouco e fecha a classe do problema por completo.
--
-- POR QUE NÃO QUEBRA USO LEGÍTIMO:
--   Os seletores de produto/fornecedor na UI (app e web) já só listam itens
--   do PRÓPRIO tenant (a query que os popula já passa pela RLS de leitura).
--   Nenhum fluxo real do app consegue gerar as combinações que esta migração
--   passa a rejeitar — só uma requisição forjada manualmente (fora da UI)
--   chegaria nelas. Mesmo padrão que `deduct_stock_on_sale`/
--   `increment_stock_on_entry` já usam sem problema desde 07/2026.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) tab_items — product_client_id precisa pertencer ao tenant da comanda
-- ---------------------------------------------------------------------
drop policy if exists tab_items_write on public.tab_items;
create policy tab_items_write on public.tab_items for all to authenticated
  using      (exists (select 1 from public.tabs t
                      where t.client_id = tab_client_id
                        and t.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(t.tenant_id)
                        and exists (select 1 from public.products p
                                    where p.client_id = tab_items.product_client_id
                                      and p.tenant_id = t.tenant_id)))
  with check (exists (select 1 from public.tabs t
                      where t.client_id = tab_client_id
                        and t.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(t.tenant_id)
                        and exists (select 1 from public.products p
                                    where p.client_id = tab_items.product_client_id
                                      and p.tenant_id = t.tenant_id)));

-- ---------------------------------------------------------------------
-- 2) stock_entries — supplier_client_id (nullable) precisa pertencer ao
-- mesmo tenant da entrada, quando informado. product_client_id já é
-- validado por trigger (increment_stock_on_entry); não duplicado aqui.
-- ---------------------------------------------------------------------
drop policy if exists stock_entries_write on public.stock_entries;
create policy stock_entries_write on public.stock_entries for all to authenticated
  using      (public.is_tenant_owner_or_manager(tenant_id)
              and public.tenant_has_access(tenant_id)
              and (supplier_client_id is null
                   or exists (select 1 from public.suppliers su
                              where su.client_id = stock_entries.supplier_client_id
                                and su.tenant_id = stock_entries.tenant_id)))
  with check (public.is_tenant_owner_or_manager(tenant_id)
              and public.tenant_has_access(tenant_id)
              and (supplier_client_id is null
                   or exists (select 1 from public.suppliers su
                              where su.client_id = stock_entries.supplier_client_id
                                and su.tenant_id = stock_entries.tenant_id)));

-- ---------------------------------------------------------------------
-- 3) product_suppliers — supplier_client_id precisa pertencer ao mesmo
-- tenant do produto (já validado no using/with check existente).
-- ---------------------------------------------------------------------
drop policy if exists product_suppliers_write on public.product_suppliers;
create policy product_suppliers_write on public.product_suppliers for all to authenticated
  using      (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner(p.tenant_id)
                        and public.tenant_has_access(p.tenant_id)
                        and exists (select 1 from public.suppliers su
                                    where su.client_id = product_suppliers.supplier_client_id
                                      and su.tenant_id = p.tenant_id)))
  with check (exists (select 1 from public.products p
                      where p.client_id = product_client_id
                        and public.is_tenant_owner(p.tenant_id)
                        and public.tenant_has_access(p.tenant_id)
                        and exists (select 1 from public.suppliers su
                                    where su.client_id = product_suppliers.supplier_client_id
                                      and su.tenant_id = p.tenant_id)));

commit;

-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO
-- =====================================================================
-- 1) As 3 policies existem com o texto novo?
--    select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public'
--       and tablename in ('tab_items','stock_entries','product_suppliers')
--       and policyname like '%_write';
--
-- 2) TESTE FUNCIONAL — nenhum destes deve inserir (bloqueado pela RLS agora).
--    Rode autenticado como owner/manager de UM tenant de teste, usando
--    client_id de um produto/fornecedor de OUTRO tenant (não pelo SQL
--    Editor, que roda como `postgres` e pula a RLS — mesmo cuidado das
--    migrações anteriores):
--      insert into public.tab_items (client_id, tab_client_id, product_client_id, name, unit_price, quantity)
--        values (gen_random_uuid(), '<comanda do MEU tenant>', '<produto de OUTRO tenant>', 'teste', 1, 1);
--      -- esperado: 0 linhas / erro de RLS
--
--      insert into public.stock_entries (tenant_id, client_id, product_client_id, supplier_client_id, quantity)
--        values ('<MEU tenant>', gen_random_uuid(), '<produto do MEU tenant>', '<fornecedor de OUTRO tenant>', 1);
--      -- esperado: 0 linhas / erro de RLS
--
--      insert into public.product_suppliers (client_id, product_client_id, supplier_client_id, purchase_price)
--        values (gen_random_uuid(), '<produto do MEU tenant>', '<fornecedor de OUTRO tenant>', 10);
--      -- esperado: 0 linhas / erro de RLS
--
-- 3) TESTE DE NÃO-REGRESSÃO — o fluxo normal continua funcionando:
--    montar uma comanda com item do PRÓPRIO catálogo, registrar entrada de
--    estoque com fornecedor PRÓPRIO, e vincular produto a fornecedor PRÓPRIO
--    pela tela normal do app/PWA. Nenhum dos três deve falhar.
-- =====================================================================
