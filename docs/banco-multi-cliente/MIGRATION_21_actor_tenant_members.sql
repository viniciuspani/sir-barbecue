-- =====================================================================
-- MIGRATION 21 — A autoria passa a apontar para o VÍNCULO, não para o Auth
-- Aplica SOBRE a MIGRATION_20 (que removeu as FKs para auth.users) e a 19.
-- Idempotente.
--
-- DIAGNÓSTICO:
--   A trilha de autoria estava ancorada em `auth.users` — uma tabela que NÃO é
--   nossa e cujo ciclo de vida é governado pelo direito de eliminação. Ancorar
--   oito FKs num registro que a lei manda apagar é o defeito de raiz; o RESTRICT
--   que travava, o SET NULL que perde o dado e o soft delete que mente eram
--   apenas sintomas.
--
--   O ator relevante num sistema multi-empresa não é "o usuário do Auth" — é
--   "o VÍNCULO daquela pessoa com aquela empresa". Esse conceito já existe em
--   `tenant_members`, com a chave certa: unique (tenant_id, user_id).
--
-- O QUE MUDA:
--   As tabelas de negócio passam a referenciar `tenant_members (tenant_id,
--   user_id)` por FK COMPOSTA. A integridade não se perde — ela muda de lugar e
--   fica MAIS FORTE: hoje nada impede registrar uma venda com o `user_id` de
--   alguém de OUTRA empresa; a partir daqui, o banco impede.
--
--   E `tenant_members` deixa de ser apagado quando alguém sai: ganha
--   `removed_at`. A linha sobrevive guardando tenant_id, user_id, papel e a data
--   — sem nome, sem e-mail, sem telefone. Nada de dado pessoal.
--
-- ESCOPO DESTA ETAPA (decisão do dono, 07/09/2026):
--   `categories` fica FORA das FKs compostas. Motivo: `trg_seed_tenant_categories`
--   dispara em `after insert on tenants` e semeia as 4 categorias padrão ANTES
--   de a linha de `tenant_members` existir (ver `handle_new_user`). Com a FK
--   composta, TODO CADASTRO NOVO QUEBRARIA. A correção — mover a semeadura para
--   o trigger de `tenant_members` — mexe no caminho crítico de cadastro e ficou
--   para uma etapa própria, com teste de ponta a ponta.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) tenant_members: soft delete + solta do Auth
-- ---------------------------------------------------------------------
alter table public.tenant_members
  add column if not exists removed_at timestamptz;

comment on column public.tenant_members.removed_at is
  'Quando a pessoa deixou a empresa. NULL = vínculo ativo. A linha NUNCA é apagada em remoção individual: ela é o ator para o qual as vendas, entradas e relatórios apontam.';

-- A FK para auth.users sai: a linha precisa sobreviver à exclusão da conta,
-- guardando o uuid como marcador opaco (sem o Auth, ele não resolve para
-- ninguém — pseudonimização que, sem o mapa, equivale a anonimização).
do $$
declare v_conname text;
begin
  select con.conname into v_conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
   where n.nspname = 'public' and rel.relname = 'tenant_members'
     and con.contype = 'f' and con.confrelid = 'auth.users'::regclass;

  if v_conname is null then
    raise notice 'MIGRATION_21: tenant_members já não tem FK para auth.users.';
  else
    execute format('alter table public.tenant_members drop constraint %I;', v_conname);
    raise notice 'MIGRATION_21: FK % removida de tenant_members.', v_conname;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2) ⚠️ OS HELPERS DE RLS PRECISAM IGNORAR QUEM SAIU
--
-- SEM ISTO A MIGRAÇÃO ABRE UM BURACO DE SEGURANÇA. `user_tenant_ids()` devolve
-- as empresas em que existe linha de vínculo — e a linha agora SOBREVIVE à
-- remoção. Um funcionário demitido, com a conta ainda ativa, continuaria com
-- acesso completo aos dados da empresa. O filtro `removed_at is null` é o que
-- transforma o soft delete em remoção de verdade.
-- ---------------------------------------------------------------------
create or replace function public.user_tenant_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select tm.tenant_id from public.tenant_members tm
   where tm.user_id = auth.uid() and tm.removed_at is null;
$$;

create or replace function public.is_tenant_owner(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id and tm.user_id = auth.uid()
      and tm.role = 'owner' and tm.removed_at is null
  );
$$;

create or replace function public.is_tenant_owner_or_manager(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id and tm.user_id = auth.uid()
      and tm.role in ('owner','manager') and tm.removed_at is null
  );
$$;

-- ---------------------------------------------------------------------
-- 3) FKs compostas: a autoria aponta para o vínculo
--
-- ON DELETE NO ACTION de propósito (e não RESTRICT): aprendemos na MIGRATION_18
-- que RESTRICT é verificado imediatamente e atrapalha cascades legítimos.
--
-- Efeito colateral BOM: com esta FK, apagar a linha de `tenant_members` de
-- alguém que tem histórico passa a ser barrado pelo próprio banco. O soft
-- delete deixa de ser convenção e vira regra imposta — inclusive contra um
-- DELETE cru via API, que a policy `members_manage` permite ao owner.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_criadas int := 0;
begin
  for r in
    select * from (values
      ('products'), ('suppliers'), ('stock_items'),
      ('stock_entries'), ('sales'), ('reports'), ('tabs')
      -- 'categories' fora: ver ESCOPO no cabeçalho.
    ) as t(tbl)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'MIGRATION_21: tabela public.% não existe — pulando.', r.tbl;
      continue;
    end if;

    if exists (
      select 1 from pg_constraint
       where conrelid = ('public.' || r.tbl)::regclass
         and conname = r.tbl || '_actor_fkey'
    ) then
      raise notice 'MIGRATION_21: %_actor_fkey já existe.', r.tbl;
      continue;
    end if;

    execute format(
      'alter table public.%I add constraint %I '
      'foreign key (tenant_id, user_id) '
      'references public.tenant_members (tenant_id, user_id) on delete no action;',
      r.tbl, r.tbl || '_actor_fkey');

    v_criadas := v_criadas + 1;
    raise notice 'MIGRATION_21: %_actor_fkey criada.', r.tbl;
  end loop;

  raise notice 'MIGRATION_21: % FK(s) composta(s) criada(s).', v_criadas;
end $$;

-- ---------------------------------------------------------------------
-- 4) ⚠️ delete_tenant_cascade PRECISA APAGAR `reports` EXPLICITAMENTE
--
-- Sem isto a exclusão de empresa volta a quebrar. `reports` não era apagada na
-- MIGRATION_19 — ela apenas cascateava de `tenants`. Agora `reports` referencia
-- `tenant_members`, que TAMBÉM cascateia de `tenants`: os dois cascades saem do
-- mesmo delete e a ordem entre eles não é determinística. É exatamente a
-- armadilha que derrubou a MIGRATION_18.
--
-- Mesma regra de sempre: nada de ordem implícita.
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

  -- 6) NOVO na MIGRATION_21: relatórios ANTES da empresa. Eles referenciam
  --    tenant_members, que cascateia de tenants no mesmo delete — deixar os dois
  --    para o cascade seria apostar na ordem da fila de triggers.
  delete from public.reports where tenant_id = p_tenant_id;

  -- 7) O resto (sync_checkpoints, tenant_members, tenant_invites, error_logs,
  --    subscriptions, tenant_devices, payments) cascateia de tenants, e nada
  --    mais aponta para eles.
  delete from public.tenants where id = p_tenant_id;
end;
$$;

revoke execute on function public.delete_tenant_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_tenant_cascade(uuid) to service_role;

-- =====================================================================
-- VERIFICAÇÃO
-- =====================================================================
-- 1) As sete FKs compostas existem:
--   select conrelid::regclass as tabela, conname
--     from pg_constraint where conname like '%_actor_fkey' order by 1;
--
-- 2) Os helpers filtram quem saiu (deve aparecer removed_at nos três):
--   select proname, prosrc like '%removed_at is null%' as filtra_removidos
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('user_tenant_ids','is_tenant_owner','is_tenant_owner_or_manager');
--
-- 3) A garantia NOVA. Nos dois casos o ERRO é o resultado BOM — ele prova que a
--    FK está ativa. Se rodar sem erro, a garantia NÃO está de pé (e sobrou uma
--    linha suja para apagar).
--
--    3a) ator que não existe em lugar nenhum:
--   insert into public.sales (tenant_id, client_id, user_id, total_amount, payment_method)
--   values (
--     (select id from public.tenants order by created_at limit 1),
--     gen_random_uuid(),
--     gen_random_uuid(),
--     10, 'cash'
--   );
--   -- esperado: 23503, viola sales_actor_fkey
--
--    3b) ator REAL, porém de outra empresa (o caso que o schema permitia antes).
--        Só é conclusivo com DUAS empresas com membro ativo — se o subselect vier
--        nulo, falha por not-null e não prova nada; aí vale só o 3a.
--   with alvo as (select id from public.tenants order by created_at limit 1)
--   insert into public.sales (tenant_id, client_id, user_id, total_amount, payment_method)
--   select alvo.id, gen_random_uuid(),
--          (select m.user_id from public.tenant_members m, alvo
--            where m.tenant_id <> alvo.id and m.removed_at is null limit 1),
--          10, 'cash'
--     from alvo;
--   -- esperado: 23503, viola sales_actor_fkey
--
-- 4) O cadastro de usuário novo CONTINUA funcionando (categories ficou de fora,
--    mas confirme mesmo assim): criar uma conta pelo app e ver as 4 categorias.
--
-- 5) Exclusão de empresa segue funcionando (regressão da MIGRATION_19):
--   select public.delete_tenant_cascade('<tenant de teste>');
--
-- 6) TESTE DO CENÁRIO NOVO — funcionário exclui a conta:
--    convidar funcionário -> ele registra UMA VENDA -> excluir a conta dele pela
--    tela -> conferir:
--      select count(*) from auth.users where email = '<dele>';               -- 0
--      select user_id from public.sales where tenant_id = '<empresa>' ...;   -- uuid preservado
--      select user_id, removed_at from public.tenant_members
--       where tenant_id = '<empresa>' and removed_at is not null;            -- 1 linha
--
-- =====================================================================
-- PENDÊNCIAS CONHECIDAS (não são desta migração)
--
-- • `categories` sem FK composta — depende de mover a semeadura para o trigger
--   de tenant_members. Etapa própria.
-- • `add_tenant_claims` (hook, hoje DESLIGADO) consulta tenant_members sem
--   filtrar removed_at. Irrelevante enquanto estiver desligado e enquanto
--   nenhuma policy usar o claim; corrigir junto se um dia for religado.
-- • `handle_new_user_invite` faz `on conflict (tenant_id, user_id) do nothing`.
--   Se um dia existir "remover membro" na interface, reconvidar a MESMA pessoa
--   não reativaria o vínculo — precisará virar `do update set removed_at = null`.
--   Hoje não acontece: conta excluída gera uuid novo no próximo cadastro.
-- • Índice (tenant_id, user_id) nas tabelas de negócio ajudaria a checagem da FK
--   ao remover membro, e o futuro relatório por funcionário. Desnecessário no
--   volume atual.
-- =====================================================================
