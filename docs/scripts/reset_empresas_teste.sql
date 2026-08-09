-- =====================================================================
-- Sir Barbecue — RESET DE TESTE: apaga TODAS as empresas e usuários,
-- mantendo apenas o super-admin (e-mail definido em app.admin_email — ver abaixo).
--
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- ATENÇÃO: IRREVERSÍVEL. Apaga dados de TODAS as empresas cadastradas
-- (produtos, categorias, vendas, estoque, fornecedores, relatórios,
-- assinaturas, pagamentos, dispositivos vinculados) e TODOS os usuários
-- de auth.users, exceto o e-mail informado abaixo.
--
-- NÃO apaga: public.app_expenses (despesas da própria aplicação/negócio,
-- não são dados de teste de empresa).
-- =====================================================================

-- >>> OBRIGATÓRIO: defina o e-mail do super-admin a PRESERVAR (não versionado).
--     Preencha antes de rodar. Se ficar vazio, o script ABORTA (fail-safe) em vez
--     de apagar o próprio admin.
select set_config('app.admin_email', '', false);  -- <<< PREENCHA: 'voce@exemplo.com'

begin;

-- Guarda fail-safe: sem e-mail definido, aborta a transação (não apaga nada).
do $$
begin
  if coalesce(current_setting('app.admin_email', true), '') = '' then
    raise exception 'Defina app.admin_email (super-admin a preservar) antes de rodar o reset.';
  end if;
end $$;

-- 1) Apaga todas as empresas — cascateia automaticamente para:
--    tenant_members, categories, products, product_day_visibility,
--    suppliers, product_suppliers, stock_items, stock_entries,
--    sales, sale_items, reports, sync_checkpoints, push_tokens,
--    subscriptions, tenant_devices, payments.
--    (TRUNCATE ... CASCADE ignora RESTRICT nas FKs filhas, então funciona
--    mesmo com as tabelas normalizadas que referenciam products/suppliers/sales
--    com ON DELETE RESTRICT.)
truncate table public.tenants cascade;

-- 2) Apaga todos os usuários de autenticação, EXCETO o super-admin.
--    Cascateia para auth.identities/auth.sessions/auth.refresh_tokens etc.
--    e também para public.platform_admins (caso algum outro admin exista).
delete from auth.users
 where email <> current_setting('app.admin_email', true);

commit;

-- =====================================================================
-- VERIFICAÇÃO PÓS-RESET (rode separadamente, fora da transação acima)
-- =====================================================================
-- select count(*) as empresas        from public.tenants;
-- select count(*) as usuarios         from auth.users;
-- select * from public.platform_admins;  -- deve conter só o seu user_id
--
-- Próximo login do super-admin (ou de um novo usuário cadastrado) vai
-- recriar uma empresa nova e vazia automaticamente (trigger handle_new_user
-- + seed_tenant_categories + seed_tenant_subscription em trial).
-- =====================================================================
