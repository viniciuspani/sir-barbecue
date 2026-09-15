-- =====================================================================
-- MIGRATION 20 — Permitir que um FUNCIONÁRIO exclua a própria conta
-- Aplica SOBRE o schema base + MIGRATION_09. Idempotente.
--
-- PROBLEMA:
--   A MIGRATION_19 destravou a exclusão para o DONO (a empresa é apagada e tudo
--   vai junto). Para um FUNCIONÁRIO continua falhando, por outro motivo: as
--   vendas, entradas de estoque e produtos que ele registrou pertencem à empresa
--   do PATRÃO e não podem ser apagadas — mas `user_id` referencia auth.users com
--   ON DELETE RESTRICT, então o usuário não pode ser removido enquanto essas
--   linhas existirem. Resultado: o funcionário fica preso à conta.
--
-- DECISÃO DO DONO (07/09/2026) — "opção B":
--   A venda continua guardando o id de quem a registrou; o que some é a PESSOA.
--   Motivo declarado: um relatório de vendas POR FUNCIONÁRIO está no plano, e
--   sem o id não haveria como agrupar.
--
--   Descartadas:
--     • ON DELETE SET NULL — perderia o agrupamento, matando o relatório futuro.
--     • Soft delete do usuário — manteria dados pessoais que ele pediu para
--       eliminar, e exigiria mexer no GoTrue.
--
-- O QUE ISTO FAZ:
--   Remove a FK das oito colunas `user_id` que apontam para auth.users com
--   RESTRICT. A COLUNA FICA — com o valor, com NOT NULL e com o
--   `default auth.uid()`. O que muda é que o banco deixa de exigir que aquele
--   usuário exista.
--
--   Efeito na LGPD: apagada a conta, o UUID deixa de resolver para uma pessoa —
--   não há mais tabela que o ligue a nome ou e-mail. Vira marcador opaco, útil
--   para agrupar, inútil para identificar. É pseudonimização que, sem o mapa,
--   equivale a anonimização.
--
-- O QUE NÃO ENTRA:
--   • `tenants.owner_user_id` — a FK fica. Para o dono, a empresa é apagada
--     ANTES (delete_tenant_cascade), então nada o referencia na hora do delete.
--     É também uma trava útil: impede empresa órfã, sem dono.
--   • `tenant_members.user_id`, `sync_checkpoints.user_id`,
--     `platform_admins.user_id` — já são CASCADE: somem com o usuário, e devem.
--   • `error_logs.user_id` e `tenant_invites.invited_by` — já são SET NULL.
--
-- CUSTO ACEITO — perda de integridade referencial:
--   Sem a FK, nada impede gravar um `user_id` que não existe. Isso NÃO abre
--   brecha de acesso: nenhuma policy destas tabelas usa `user_id` para
--   autorizar — todas isolam por `tenant_id in (select user_tenant_ids())` ou
--   pelos helpers `is_tenant_*` (conferido no dump de produção de 02/09/2026).
--   O risco é de trilha de auditoria mentirosa, não de vazamento. E o valor
--   continua vindo do `default auth.uid()`, que o cliente não controla quando
--   omite a coluna.
-- =====================================================================

do $$
declare
  r          record;
  v_conname  text;
  v_removidas int := 0;
begin
  for r in
    select * from (values
      ('categories',    'user_id'),
      ('products',      'user_id'),
      ('suppliers',     'user_id'),
      ('stock_items',   'user_id'),
      ('stock_entries', 'user_id'),
      ('sales',         'user_id'),
      ('reports',       'user_id'),
      ('tabs',          'user_id')     -- MIGRATION_09
    ) as t(tbl, col)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'MIGRATION_20: tabela public.% não existe — pulando.', r.tbl;
      continue;
    end if;

    -- Localiza a FK desta coluna que aponta para auth.users. Resolver pelo
    -- catálogo (em vez de assumir `<tabela>_user_id_fkey`) evita falhar em
    -- silêncio se algum nome divergir.
    select con.conname
      into v_conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = r.tbl
       and con.contype = 'f'
       and con.confrelid = 'auth.users'::regclass
       and exists (
         select 1
           from unnest(con.conkey) as k
           join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
          where a.attname = r.col
       );

    if v_conname is null then
      raise notice 'MIGRATION_20: %.% já não tem FK para auth.users.', r.tbl, r.col;
      continue;
    end if;

    execute format('alter table public.%I drop constraint %I;', r.tbl, v_conname);
    v_removidas := v_removidas + 1;
    raise notice 'MIGRATION_20: FK % removida de %.%.', v_conname, r.tbl, r.col;
  end loop;

  raise notice 'MIGRATION_20: % FK(s) removida(s).', v_removidas;
end $$;

-- =====================================================================
-- VERIFICAÇÃO
-- =====================================================================
-- 1) Nenhuma das oito deve mais aparecer (só `tenants.owner_user_id` fica):
--
--   select rel.relname as tabela, a.attname as coluna, con.conname
--     from pg_constraint con
--     join pg_class rel on rel.oid = con.conrelid
--     join pg_namespace n on n.oid = rel.relnamespace
--     join unnest(con.conkey) as k on true
--     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
--    where n.nspname = 'public' and con.contype = 'f'
--      and con.confrelid = 'auth.users'::regclass
--    order by 1;
--   -- esperado: tenants/owner_user_id, tenant_members/user_id (cascade),
--   --           sync_checkpoints/user_id (cascade), error_logs/user_id (set null),
--   --           tenant_invites/invited_by (set null), platform_admins/user_id (cascade)
--
-- 2) As colunas continuam íntegras — NOT NULL e default preservados:
--
--   select column_name, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'sales' and column_name = 'user_id';
--   -- esperado: NO / auth.uid()
--
-- 3) TESTE REAL — funcionário exclui a própria conta:
--    a) convidar um funcionário para uma empresa de teste;
--    b) com a conta dele, registrar UMA VENDA (é o que travava);
--    c) excluir a conta pela tela do app;
--    d) conferir:
--       select count(*) from auth.users where email = '<email do funcionario>';  -- 0
--       select user_id from public.sales where tenant_id = '<empresa>' order by created_at desc limit 1;
--       -- a venda CONTINUA lá, com o uuid do funcionário preservado
--
-- =====================================================================
-- NOTA para quem for construir o relatório de vendas por funcionário
--
-- Esta migração preserva o AGRUPAMENTO, não o NOME. Com o funcionário ativo, o
-- nome sai de um join em `tenant_members`/`auth.users`. Depois que ele exclui a
-- conta, essa linha some (tenant_members.user_id é CASCADE) e resta o UUID puro:
-- as vendas seguem agrupáveis por operador, sem rótulo.
--
-- Se o relatório precisar exibir o nome de quem já saiu, será necessário guardar
-- esse nome em algum lugar — e aí a discussão sobre dado pessoal volta, agora
-- com o agravante de ser um dado que a pessoa pediu para eliminar. Decidir isso
-- ao construir o relatório, não antes.
-- =====================================================================
