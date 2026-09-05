-- =====================================================================
-- MIGRATION 17 — Fechar a superfície ANÔNIMA de execução de funções
-- Aplica SOBRE todo o resto. Idempotente (pode rodar quantas vezes quiser).
--
-- MOTIVAÇÃO:
--   Auditoria de 03/09/2026 (docs/auditoria-seguranca-web). A consulta
--
--     select p.proname from pg_proc p
--      where p.pronamespace = 'public'::regnamespace
--        and has_function_privilege('anon', p.oid, 'EXECUTE');
--
--   devolveu 37 funções — ou seja, quase tudo em `public` era executável com a
--   anon key, que é pública (vai no bundle do PWA). Nenhuma delas se mostrou
--   explorável: as 16 `admin_*` abrem com `if not is_platform_admin() then raise
--   exception`, os helpers devolvem vazio sem `auth.uid()`, `create_sale` é
--   `security invoker` e esbarra na RLS, e 11 são funções de trigger, que o
--   Postgres nem deixa chamar diretamente.
--
--   Mas nada disso era por desenho — era o default do Postgres somado aos
--   default privileges do Supabase. A segurança dependia inteiramente da segunda
--   linha de defesa (a checagem interna de cada função). Esta migração alinha a
--   permissão à intenção: quem não precisa ser anônimo, deixa de ser.
--
-- A DESCOBERTA QUE MOTIVA O `from public, anon`:
--   `revoke ... from public` NÃO BASTA no Supabase. A plataforma concede EXECUTE
--   a `anon` por default privileges, e isso é um grant EXPLÍCITO — revogar de
--   PUBLIC não o remove. Evidência colhida em produção:
--
--     create_sale:  {postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, ...}
--
--   A MIGRATION_09 já fazia `revoke all on function create_sale from public`, e
--   ainda assim `anon` continuava com acesso. O `=X/postgres` (PUBLIC) sumiu; o
--   `anon=X/postgres` ficou. Por isso aqui revogamos dos DOIS.
--
-- O QUE CONTINUA ANÔNIMO (proposital):
--   • has_pending_invite(text) — a tela de CADASTRO chama antes de haver login,
--     para saber se o e-mail tem convite pendente. Devolve só um booleano.
--   • saude_db() — a Edge Function `health` usa a anon key de propósito (o
--     monitor externo não tem credencial do Supabase). Devolve só ok/latência.
--
-- POR QUE NÃO QUEBRA NADA LOGADO:
--   O loop RE-CONCEDE a `authenticated` antes de revogar, mas SOMENTE nas
--   funções em que ele já tinha o privilégio. Assim, quem dependia do grant via
--   PUBLIC passa a ter grant próprio, e quem foi deliberadamente revogado de
--   `authenticated` (cleanup_product_supplier_price_history,
--   send_subscription_due_reminders, add_tenant_claims) CONTINUA revogado.
--   `service_role` e `postgres` não são tocados — as Edge Functions seguem iguais.
-- =====================================================================

do $$
declare
  r record;
  v_total int := 0;
begin
  for r in
    select p.oid::regprocedure as sig,
           -- Avaliado ANTES do revoke: preserva exatamente o estado atual.
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_tinha
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and p.proname not in ('has_pending_invite', 'saude_db')   -- exceções acima
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    if r.auth_tinha then
      execute format('grant execute on function %s to authenticated;', r.sig);
    end if;
    execute format('revoke execute on function %s from public, anon;', r.sig);
    v_total := v_total + 1;
  end loop;

  raise notice 'MIGRATION_17: EXECUTE revogado de anon/public em % função(ões).', v_total;
end $$;

-- ---------------------------------------------------------------------
-- Default privileges: impede que a PRÓXIMA função nasça anônima.
--
-- Sem isto, qualquer função criada daqui pra frente volta a receber EXECUTE
-- para `anon` automaticamente, e a superfície se reabre em silêncio — a mesma
-- classe de regressão silenciosa documentada em CONFERENCIA_POLICIES_PRODUCAO.md.
--
-- Efeito: vale para as funções criadas pelo papel que RODA esta linha (o
-- `postgres` do SQL Editor, que é quem cria tudo aqui). A partir de agora,
-- função que precise ser pública exige um `grant execute ... to anon` explícito
-- — que é a disciplina desejada: o acesso anônimo passa a ser uma decisão
-- escrita, não um default herdado.
--
-- Para reverter:
--   alter default privileges in schema public grant execute on functions to anon;
-- ---------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from anon;

-- =====================================================================
-- VERIFICAÇÃO
-- =====================================================================
-- Deve devolver EXATAMENTE has_pending_invite e saude_db:
--
--   select p.proname
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and has_function_privilege('anon', p.oid, 'EXECUTE')
--    order by 1;
--
-- Conferir que o app logado não perdeu nada (rodar como usuário autenticado):
--   select public.user_tenant_ids();
--   select public.get_access_status('<tenant>');
-- E, pela interface: vender, abrir/fechar comanda, gerar relatório e convidar
-- membro — os quatro fluxos que passam por função ou Edge Function.

-- =====================================================================
-- NOTA — event trigger `ensure_rls` / função `rls_auto_enable`
--
-- Existe em produção, NÃO está versionada em nenhum script deste repositório
-- (foi criada fora dele). É `returns event_trigger`, SECURITY DEFINER, ligada a
-- `ddl_command_end`: a cada CREATE TABLE em `public` ela dispara
-- `alter table ... enable row level security`, com EXCEPTION WHEN OTHERS para
-- nunca derrubar o DDL. É ela que garante que toda tabela nova nasça com RLS.
--
-- NÃO REMOVER. Ela não é chamável por ninguém (o PostgREST não expõe função de
-- event trigger e o Postgres recusa invocação direta), então não entra na
-- revogação acima — aparecia na lista do `anon` apenas como ruído.
--
-- Efeito colateral a conhecer: ela habilita a RLS mas NÃO cria policy. Tabela
-- nova nasce FECHADA para todos até alguém escrever a policy — que é o padrão
-- correto, mas explica um eventual "criei a tabela e o app não lê nada".
--
-- Para inspecionar:
--   select prosrc from pg_proc where proname = 'rls_auto_enable';
--   select evtname, evtevent, evtenabled from pg_event_trigger where evtname = 'ensure_rls';
-- =====================================================================
