-- =====================================================================
-- MIGRATION 13 — Fornecedor e custo: leitura só para owner|manager
-- Correção do achado A01-01 (Auditoria OWASP 2025, docs/auditoria-seguranca-web).
-- Aplica SOBRE SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql. Idempotente.
--
-- PROBLEMA:
--   A interface esconde Fornecedores, custo e margem do papel `employee`
--   (permissions.ts / RequireRole no web, mesma matriz no mobile), mas a RLS
--   liberava a LEITURA dessas tabelas a qualquer membro da empresa. Um
--   funcionário com o próprio token — copiado do app em 30 segundos — lia pela
--   API a lista completa de fornecedores com telefone e endereço, o preço de
--   compra de cada produto e toda a série histórica de custo:
--
--     curl ".../rest/v1/product_suppliers?select=*" \
--          -H "apikey: <anon>" -H "Authorization: Bearer <token do funcionário>"
--
--   Não é vazamento ENTRE empresas (a RLS de tenant continua correta) — é
--   vazamento dentro de uma faixa de confiança que o produto prometeu não dar.
--   Preço de compra e margem são a informação comercial mais sensível de um PDV.
--
-- ESCOPO (decisão do dono do produto, 31/08/2026):
--   `sales` fica EXATAMENTE como está — diferentes usuários precisam enxergar a
--   venda. Esta migração mexe apenas em fornecedor/custo.
--
-- IMPACTO NO APP:
--   Para o employee, `pullSuppliers` e o pull de vínculos passam a retornar
--   ZERO linhas — a RLS filtra em silêncio, não gera erro, então o sync não
--   quebra (verificado em src/data/sync/syncEngine.ts: o pull só lança em
--   `error`, não em resultado vazio). O aparelho do funcionário simplesmente
--   deixa de receber dado que a tela dele nunca mostrou.
--   Sobre o que JÁ está no aparelho do funcionário:
--     • `product_suppliers` (o custo de compra) se autolimpa no primeiro sync —
--       `pullProductSuppliers` reconcilia exclusões apagando local o que não
--       voltou do servidor (syncEngine.ts:708-713). Como o servidor passa a
--       devolver zero linhas para ele, o custo some do SQLite dele sozinho. A
--       exclusão é só local: nada é apagado no servidor.
--     • `suppliers` (nome/telefone/endereço) NÃO tem essa reconciliação — as
--       linhas já baixadas permanecem no aparelho. Se isso importar no seu caso,
--       limpe os dados do app naquele aparelho uma vez.
-- =====================================================================

-- suppliers: leitura owner|manager (a escrita já era só owner)
drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated
  using (public.is_tenant_owner_or_manager(tenant_id));

-- product_suppliers (filha do produto): idem, via EXISTS no pai
drop policy if exists product_suppliers_select on public.product_suppliers;
create policy product_suppliers_select on public.product_suppliers for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and public.is_tenant_owner_or_manager(p.tenant_id)));

-- histórico de custo: idem (a tabela já era somente-leitura para o app; quem
-- escreve é a trigger trg_log_price_history, que é SECURITY DEFINER)
drop policy if exists tenant_select on public.product_supplier_price_history;
create policy tenant_select on public.product_supplier_price_history for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and public.is_tenant_owner_or_manager(p.tenant_id)));

-- ---------------------------------------------------------------------
-- Verificação
-- ---------------------------------------------------------------------
-- Com uma sessão de EMPLOYEE, as três consultas devem devolver 0 linhas:
--   select count(*) from public.suppliers;
--   select count(*) from public.product_suppliers;
--   select count(*) from public.product_supplier_price_history;
-- Com owner ou manager, devem devolver o conteúdo normal da empresa.
