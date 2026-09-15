-- =====================================================================
-- MIGRATION 18 — Destravar a EXCLUSÃO DE EMPRESA (RNF-08)
-- Aplica SOBRE o schema base + MIGRATION_09 (tabs). Idempotente.
--
-- PROBLEMA (descoberto em 07/09/2026, testando a exclusão de conta):
--   `delete from tenants` SEMPRE falhou para qualquer empresa que já tivesse
--   feito uma venda. O erro real, colhido no log da Edge Function:
--
--     23503: update or delete on table "products" violates foreign key
--     constraint "sale_items_product_client_id_fkey" on table "sale_items"
--
--   Ou seja: a exclusão de conta (RNF-08) nunca funcionou para uma empresa real.
--   Só não apareceu antes porque nunca foi testada com dados de venda.
--
-- POR QUE ACONTECE — a diferença entre RESTRICT e NO ACTION:
--   Apagar a empresa dispara DOIS caminhos de cascade ao mesmo tempo:
--     tenants -> sales -> sale_items   (o filho seria removido)
--     tenants -> products              (o pai seria removido)
--   `sale_items.product_client_id` aponta para products com ON DELETE RESTRICT,
--   e **RESTRICT é verificado IMEDIATAMENTE** — ele barra mesmo quando as linhas
--   que referenciam seriam apagadas um instante depois pelo outro caminho.
--   `NO ACTION` verifica no FIM DA INSTRUÇÃO: aí `sale_items` já foi removido
--   junto com `sales`, e a exclusão passa.
--
--   A REGRA DE NEGÓCIO CONTINUA DE PÉ. Apagar um produto que tem vendas continua
--   falhando: nesse caso ninguém removeu as linhas de `sale_items`, elas seguem
--   lá no fim da instrução e a verificação reprova. O que muda é só o momento da
--   checagem — não a proteção.
--
-- ESCOPO: mexe apenas nas FKs cujo filho É removido por algum cascade a partir
--   de `tenants`. As demais RESTRICT ficam intactas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RESTRICT -> NO ACTION nas seis FKs que travam o cascade
--
-- Resolve o NOME da constraint no catálogo em vez de assumir a convenção
-- `<tabela>_<coluna>_fkey`: se algum nome divergir, o bloco avisa em vez de
-- falhar em silêncio. O filtro `confdeltype = 'r'` (RESTRICT) torna a migração
-- idempotente — na segunda execução não há mais o que trocar.
-- ---------------------------------------------------------------------
do $$
declare
  r         record;
  v_conname text;
  v_trocadas int := 0;
begin
  for r in
    select * from (values
      -- (tabela filha,      coluna,               tabela pai)
      ('products',          'category_client_id',  'categories'),
      ('stock_items',       'product_client_id',   'products'),
      ('stock_entries',     'product_client_id',   'products'),
      ('stock_entries',     'supplier_client_id',  'suppliers'),
      ('sale_items',        'product_client_id',   'products'),
      ('tab_items',         'product_client_id',   'products')
    ) as t(tbl, col, reftbl)
  loop
    -- A tabela pode não existir (ex.: tab_items sem a MIGRATION_09 aplicada).
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'MIGRATION_18: tabela public.% não existe — pulando.', r.tbl;
      continue;
    end if;

    select con.conname
      into v_conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = r.tbl
       and con.contype = 'f'
       and con.confdeltype = 'r'          -- 'r' = RESTRICT ; 'a' = NO ACTION
       and exists (
         select 1
           from unnest(con.conkey) as k
           join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
          where a.attname = r.col
       );

    if v_conname is null then
      raise notice 'MIGRATION_18: %.% já não é RESTRICT — nada a fazer.', r.tbl, r.col;
      continue;
    end if;

    execute format('alter table public.%I drop constraint %I;', r.tbl, v_conname);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) '
      'references public.%I (client_id) on delete no action;',
      r.tbl, v_conname, r.col, r.reftbl);

    v_trocadas := v_trocadas + 1;
    raise notice 'MIGRATION_18: %.% -> NO ACTION (constraint %).', r.tbl, r.col, v_conname;
  end loop;

  raise notice 'MIGRATION_18: % constraint(s) alterada(s).', v_trocadas;
end $$;

-- ---------------------------------------------------------------------
-- 2) A exceção: product_suppliers
--
-- É a ÚNICA tabela do grafo SEM caminho de cascade a partir de `tenants`: não
-- tem `tenant_id`, e suas duas FKs (products, suppliers) são RESTRICT. Trocar
-- para NO ACTION aqui NÃO resolveria — pelo contrário: as linhas sobreviveriam
-- ao delete da empresa, ficariam órfãs, e a verificação de fim de instrução
-- reprovaria do mesmo jeito.
--
-- E a RESTRICT dela é útil no dia a dia: é o que impede excluir um fornecedor
-- que está em uso por algum produto. Não queremos perder essa trava trocando-a
-- por CASCADE (que apagaria os vínculos em silêncio).
--
-- Solução: apagar essas linhas EXPLICITAMENTE, antes da empresa, dentro de uma
-- função. No uso normal a trava continua valendo; só o caminho de exclusão de
-- empresa passa por cima dela, de forma deliberada e visível.
-- ---------------------------------------------------------------------
create or replace function public.delete_tenant_cascade(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Vínculos produto-fornecedor da empresa. Os dois lados (por produto e por
  -- fornecedor) por robustez: o app só cria vínculos dentro da mesma empresa,
  -- mas se algum registro inconsistente existir, o delete do pai falharia.
  delete from public.product_suppliers ps
   using public.products p
   where p.client_id = ps.product_client_id
     and p.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.suppliers s
   where s.client_id = ps.supplier_client_id
     and s.tenant_id = p_tenant_id;

  -- Daqui em diante o cascade dá conta: todas as demais tabelas do grafo têm
  -- `tenant_id` com ON DELETE CASCADE, ou pendem de um pai que tem.
  delete from public.tenants where id = p_tenant_id;
end;
$$;

comment on function public.delete_tenant_cascade(uuid) is
  'Exclui a empresa e TODOS os seus dados, numa transação. Remove antes os vínculos produto-fornecedor, única tabela sem caminho de cascade. Uso exclusivo do servidor (Edge Function delete-account).';

-- Só o servidor executa: quem chama é a Edge Function delete-account, com a
-- service_role, DEPOIS de reautenticar o usuário (senha ou e-mail — ver A06-03).
-- Exposta a `authenticated`, seria exclusão de empresa a um POST de distância.
revoke execute on function public.delete_tenant_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_tenant_cascade(uuid) to service_role;

-- =====================================================================
-- VERIFICAÇÃO
-- =====================================================================
-- 1) As seis FKs devem aparecer como 'a' (NO ACTION):
--
--   select rel.relname as tabela, con.conname, con.confdeltype as acao_delete
--     from pg_constraint con
--     join pg_class rel on rel.oid = con.conrelid
--     join pg_namespace n on n.oid = rel.relnamespace
--    where n.nspname = 'public' and con.contype = 'f'
--      and con.conname in (
--        'products_category_client_id_fkey', 'stock_items_product_client_id_fkey',
--        'stock_entries_product_client_id_fkey', 'stock_entries_supplier_client_id_fkey',
--        'sale_items_product_client_id_fkey', 'tab_items_product_client_id_fkey')
--    order by 1;
--
-- 2) A regra de negócio NÃO pode ter sido afetada — isto deve CONTINUAR falhando
--    (produto com venda registrada):
--
--   delete from public.products where client_id = '<produto que tem venda>';
--   -- esperado: 23503, violates foreign key constraint ... on table "sale_items"
--
-- 3) Teste real, em empresa DESCARTÁVEL com vendas, comandas e estoque:
--
--   select public.delete_tenant_cascade('<tenant de teste>');
--   select count(*) from public.tenants where id = '<tenant de teste>';  -- 0
--
-- =====================================================================
-- NOTA — o caso que esta migração NÃO resolve
--
-- Um FUNCIONÁRIO excluir a própria conta continua falhando, por outro motivo:
-- `sales.user_id`, `products.user_id` e outras seis colunas referenciam
-- auth.users com ON DELETE RESTRICT. As vendas que ele registrou pertencem à
-- empresa do patrão e NÃO devem ser apagadas — mas o RESTRICT impede excluir o
-- usuário enquanto elas existirem.
--
-- A saída ali é diferente: `user_id` virar anulável com ON DELETE SET NULL,
-- preservando a venda e perdendo apenas a autoria. É mudança de modelo (as
-- colunas hoje são NOT NULL) e fica para uma migração própria, com decisão sobre
-- o que a trilha de auditoria deve mostrar quando o autor não existe mais.
-- =====================================================================
