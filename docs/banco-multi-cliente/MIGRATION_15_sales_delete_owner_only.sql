-- =====================================================================
-- MIGRATION 15 — OPCIONAL — venda só pode ser apagada pelo dono
-- Correção do achado A01-03 (Auditoria OWASP 2025, docs/auditoria-seguranca-web).
-- Aplica DEPOIS de MIGRATION_11 (substitui as policies de escrita que ela criou).
-- Idempotente.
--
-- POR QUE ESTÁ SEPARADA DAS DEMAIS:
--   Você determinou que `sales` deve manter a permissão de hoje, porque
--   diferentes usuários precisam enxergar a venda. Esta migração NÃO mexe na
--   leitura — `sales_select` continua liberando toda venda da empresa a todo
--   membro, exatamente como hoje — e não mexe em INSERT nem em UPDATE. Ela
--   restringe apenas o DELETE. Está em arquivo próprio para você decidir sobre
--   ela isoladamente, sem prender o resto do plano.
--
-- O QUE ELA CORRIGE:
--   A policy original era `for all`, o que inclui DELETE. O PWA nunca oferece
--   "apagar venda", mas a API oferece:
--
--     curl -X DELETE ".../rest/v1/sales?client_id=eq.<uuid>" \
--          -H "apikey: <anon>" -H "Authorization: Bearer <token do funcionário>"
--
--   O funcionário registra a venda (o cliente vê o valor certo, o estoque
--   baixa), recebe em espécie e apaga a linha. O `sale_items` cai por cascade,
--   mas a baixa de estoque NÃO é revertida: o estoque continua coerente e só o
--   faturamento encolhe. É o padrão clássico de sangria de caixa em PDV.
--
-- RISCO DE APLICAR: praticamente nulo.
--   Nenhum dos dois clientes apaga venda. Verificado:
--     • web:    src/data/repositories/sales.ts só faz SELECT;
--     • mobile: src/data/sync/syncEngine.ts só faz DELETE remoto em
--               product_day_visibility, product_suppliers e tab_items —
--               nunca em sales ou sale_items.
--   INSERT e UPDATE seguem liberados a todo membro de propósito: o push do sync
--   do Android faz upsert por client_id (ON CONFLICT DO UPDATE), e travar o
--   UPDATE quebraria o reenvio idempotente depois de uma falha de rede. A
--   alteração de `total_amount` fica coberta pela trilha da MIGRATION_14
--   ('sale.amount_change'), que registra valor antes e depois, com o autor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- sales — a policy `for all` vira insert + update (membros) e delete (owner)
-- ---------------------------------------------------------------------
drop policy if exists sales_write on public.sales;
drop policy if exists sales_insert on public.sales;
drop policy if exists sales_update on public.sales;
drop policy if exists sales_delete on public.sales;

create policy sales_insert on public.sales for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id));

create policy sales_update on public.sales for update to authenticated
  using      (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id))
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id));

-- DELETE: só o dono da empresa. Sem exigir assinatura ativa — apagar não é
-- "operar", e um cliente que saiu precisa conseguir remover o próprio dado.
create policy sales_delete on public.sales for delete to authenticated
  using (public.is_tenant_owner(tenant_id));

-- ---------------------------------------------------------------------
-- sale_items — mesma separação, isolando pela venda-pai
-- ---------------------------------------------------------------------
drop policy if exists sale_items_write on public.sale_items;
drop policy if exists sale_items_insert on public.sale_items;
drop policy if exists sale_items_update on public.sale_items;
drop policy if exists sale_items_delete on public.sale_items;

create policy sale_items_insert on public.sale_items for insert to authenticated
  with check (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(s.tenant_id)));

create policy sale_items_update on public.sale_items for update to authenticated
  using      (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(s.tenant_id)))
  with check (exists (select 1 from public.sales s
                      where s.client_id = sale_client_id
                        and s.tenant_id in (select public.user_tenant_ids())
                        and public.tenant_has_access(s.tenant_id)));

create policy sale_items_delete on public.sale_items for delete to authenticated
  using (exists (select 1 from public.sales s
                 where s.client_id = sale_client_id
                   and public.is_tenant_owner(s.tenant_id)));

-- NOTA sobre comandas: `tabs` e `tab_items` NÃO entram aqui. Apagar item de
-- comanda aberta é operação legítima e usada pelos dois clientes
-- (web: repositories/tabs.ts:137; mobile: syncEngine.ts:504).

-- ---------------------------------------------------------------------
-- Verificação
-- ---------------------------------------------------------------------
-- Com sessão de EMPLOYEE, o DELETE deve afetar 0 linhas (a RLS filtra em silêncio):
--   delete from public.sales where client_id = '<uuid de venda da empresa>';
-- Com sessão de OWNER, deve apagar — e deixar o registro em audit_log:
--   select action, target, actor_id, at from public.audit_log
--    where action = 'sale.delete' order by at desc limit 5;
