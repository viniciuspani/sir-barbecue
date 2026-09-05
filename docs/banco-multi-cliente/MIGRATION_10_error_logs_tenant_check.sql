-- =====================================================================
-- MIGRATION 10 — error_logs: validar o tenant_id no INSERT/UPDATE
-- Correção do achado A01-04 (Auditoria OWASP 2025, docs/auditoria-seguranca-web).
-- Aplica SOBRE MIGRATION_05_error_logs.sql. Idempotente.
--
-- PROBLEMA:
--   A policy de INSERT validava apenas `user_id = auth.uid()`. O tenant_id vem
--   do cliente (mobile e web carimbam a coluna no envio), então qualquer usuário
--   autenticado conseguia gravar linhas de log carimbadas com o tenant_id de
--   OUTRA empresa. Como a leitura é liberada ao owner daquele tenant, o conteúdo
--   forjado (message, action, user_message) apareceria no painel de erros do dono
--   alheio e no painel do super-admin.
--
-- CORREÇÃO:
--   Exigir que o tenant_id, quando informado, seja uma das empresas do próprio
--   usuário. O `is null` é preservado de propósito: erro ocorrido ANTES do
--   vínculo com empresa (ou antes do login) é justamente o mais difícil de
--   diagnosticar e precisa continuar chegando ao servidor — ver MIGRATION_05.
-- =====================================================================

drop policy if exists error_logs_insert on public.error_logs;
create policy error_logs_insert on public.error_logs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (tenant_id is null or tenant_id in (select public.user_tenant_ids()))
  );

-- UPDATE (upsert idempotente por client_id): mesma regra, nos dois lados.
-- Sem o `with check`, o usuário poderia inserir uma linha válida e, no UPDATE
-- seguinte, reescrevê-la apontando para o tenant de outra empresa.
drop policy if exists error_logs_update on public.error_logs;
create policy error_logs_update on public.error_logs
  for update to authenticated
  using (
    user_id = auth.uid()
    and (tenant_id is null or tenant_id in (select public.user_tenant_ids()))
  )
  with check (
    user_id = auth.uid()
    and (tenant_id is null or tenant_id in (select public.user_tenant_ids()))
  );

-- ---------------------------------------------------------------------
-- Verificação
-- ---------------------------------------------------------------------
-- select policyname, cmd, qual, with_check
--   from pg_policies
--  where schemaname = 'public' and tablename = 'error_logs'
--  order by policyname;
