-- =====================================================================
-- MIGRATION 06 — RPC de saúde do banco (usada pela Edge Function `health`)
-- Aplica SOBRE o schema multi-tenant já implantado. Idempotente.
-- Rode no Supabase → SQL Editor → New query → cole tudo → Run.
--
-- MOTIVAÇÃO (monitoramento externo):
--   O endpoint público /functions/v1/health precisa provar que o Postgres está
--   respondendo de verdade — não só que o runtime das Edge Functions subiu.
--   Para isso ele faz um round-trip real no banco chamando esta RPC.
--
--   A função é SECURITY DEFINER para que a Edge Function possa usar apenas a
--   ANON KEY (sem service_role): um endpoint público não deve carregar a chave
--   mais poderosa do projeto. O `perform` toca uma tabela real do schema, então
--   o check falha se o banco estiver fora, sem conexões ou com o schema quebrado
--   — não apenas se a rede estiver ruim.
--
-- NOTA DE SEGURANÇA: a RPC é chamável por anônimos, mas NÃO devolve dado algum
--   do cliente — nem id, nem nome, nem contagem de empresas. Só `ok` + hora do
--   banco. `stable` garante que não escreve nada.
-- =====================================================================

create or replace function public.saude_db()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform 1 from public.tenants limit 1;   -- toca uma tabela real do schema
  return jsonb_build_object('ok', true, 'db_time', now());
end; $$;

revoke all on function public.saude_db() from public;
grant execute on function public.saude_db() to anon, authenticated, service_role;

-- =====================================================================
-- VERIFICAÇÃO
--   select public.saude_db();          -- => {"ok": true, "db_time": "..."}
--
-- TESTE DO CAMINHO DE FALHA (reversível) — para validar que o alerta dispara:
--   revoke execute on function public.saude_db() from anon;   -- /health passa a responder 503
--   grant  execute on function public.saude_db() to anon;     -- volta ao normal (200)
-- =====================================================================
