-- =====================================================================
-- MIGRATION 05 — Log de erros do aplicativo
-- Aplica SOBRE o schema multi-tenant + licenciamento já implantados.
-- Idempotente. Rode no Supabase → SQL Editor → New query → cole tudo → Run.
--
--  • Tabela error_logs: data/hora, o que o usuário estava fazendo (tela + ação +
--    trilha de navegação) e a mensagem completa do erro (stack, code, details).
--  • O app grava LOCAL primeiro (SQLite, offline-first) e sobe pelo sync.
--  • RLS: cada usuário só INSERE o próprio registro; a leitura é do dono da
--    aplicação (painel web) e do owner da empresa.
--  • RPCs admin_* para o painel do dono, no mesmo padrão das já existentes.
-- =====================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1) TABELA
-- ---------------------------------------------------------------------
-- tenant_id e user_id são NULLABLE de propósito: um erro pode acontecer antes do
-- login ou antes de o usuário ter vínculo com empresa — justamente os casos mais
-- difíceis de diagnosticar. O app carimba o que souber no momento do envio.
create table if not exists public.error_logs (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null unique,                 -- = id local (idempotência do upsert)
  tenant_id     uuid references public.tenants (id) on delete cascade,
  user_id       uuid default auth.uid() references auth.users (id) on delete set null,
  ref_code      varchar(12) not null,                 -- código curto mostrado ao usuário
  occurred_at   timestamptz not null,                 -- data e hora do erro (do aparelho)
  severity      varchar(10) not null default 'error'
                check (severity in ('error', 'fatal')),
  screen        varchar(120),                         -- rota (ex.: /venda/fechar)
  action        varchar(200),                         -- o que o usuário estava fazendo
  message       text not null,                        -- mensagem curta
  detail        text,                                 -- mensagem COMPLETA: stack + code/details/hint
  user_message  text,                                 -- o que foi exibido ao usuário
  context       jsonb,                                -- trilha de navegação, conectividade, papel
  app_version   varchar(20),
  platform      varchar(10),
  os_version    varchar(40),
  created_at    timestamptz not null default now()    -- quando chegou ao servidor
);

create index if not exists idx_error_logs_tenant    on public.error_logs (tenant_id, occurred_at desc);
create index if not exists idx_error_logs_ref_code  on public.error_logs (ref_code);
create index if not exists idx_error_logs_severity  on public.error_logs (severity, occurred_at desc);
create index if not exists idx_error_logs_occurred  on public.error_logs (occurred_at desc);

-- ---------------------------------------------------------------------
-- 2) RLS
-- ---------------------------------------------------------------------
alter table public.error_logs enable row level security;

-- INSERT: qualquer usuário autenticado registra o PRÓPRIO erro (inclusive sem
-- empresa vinculada). Sem esta política aberta, o erro de quem ainda não entrou
-- numa empresa — o mais crítico de investigar — nunca chegaria ao servidor.
drop policy if exists error_logs_insert on public.error_logs;
create policy error_logs_insert on public.error_logs
  for insert to authenticated
  with check (user_id = auth.uid());

-- UPDATE: o app faz upsert por client_id (reenvio idempotente após falha de rede),
-- então precisa poder reescrever a PRÓPRIA linha — e somente ela.
drop policy if exists error_logs_update on public.error_logs;
create policy error_logs_update on public.error_logs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- SELECT: dono da aplicação (painel) ou owner da empresa. O funcionário NÃO lê o
-- log — ele contém detalhe técnico de toda a operação da empresa.
drop policy if exists error_logs_select on public.error_logs;
create policy error_logs_select on public.error_logs
  for select to authenticated
  using (
    public.is_platform_admin()
    or (tenant_id is not null and public.is_tenant_owner(tenant_id))
  );

-- DELETE: só o dono da aplicação (a limpeza roda pela RPC abaixo).
drop policy if exists error_logs_delete on public.error_logs;
create policy error_logs_delete on public.error_logs
  for delete to authenticated
  using (public.is_platform_admin());

-- ---------------------------------------------------------------------
-- 3) RPCs DE ADMINISTRAÇÃO (painel do dono) — retornam camelCase
-- ---------------------------------------------------------------------

-- Lista paginada com filtros. p_search casa com o código de referência (o que o
-- cliente dita por telefone), a ação ou a mensagem.
create or replace function public.admin_list_error_logs(
  p_tenant_id uuid default null,
  p_severity  text default null,
  p_search    text default null,
  p_limit     integer default 100,
  p_offset    integer default 0
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  return coalesce((
    select jsonb_agg(row_obj order by row_obj->>'occurredAt' desc)
    from (
      select jsonb_build_object(
        'id',          l.id,
        'refCode',     l.ref_code,
        'occurredAt',  l.occurred_at,
        'severity',    l.severity,
        'tenantId',    l.tenant_id,
        'tenantName',  t.name,
        'userId',      l.user_id,
        'userEmail',   u.email,
        'screen',      l.screen,
        'action',      l.action,
        'message',     l.message,
        'userMessage', l.user_message,
        'appVersion',  l.app_version,
        'platform',    l.platform
      ) as row_obj
      from public.error_logs l
      left join public.tenants t on t.id = l.tenant_id
      left join auth.users   u on u.id = l.user_id
      where (p_tenant_id is null or l.tenant_id = p_tenant_id)
        and (p_severity  is null or l.severity  = p_severity)
        and (
          v_search is null
          or l.ref_code ilike '%' || v_search || '%'
          or l.action   ilike '%' || v_search || '%'
          or l.message  ilike '%' || v_search || '%'
        )
      order by l.occurred_at desc
      limit v_limit offset greatest(coalesce(p_offset, 0), 0)
    ) s
  ), '[]'::jsonb);
end; $$;

-- Detalhe completo de UM registro: é aqui que vem o stack e a trilha do usuário.
create or replace function public.admin_error_log_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_row jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  select jsonb_build_object(
    'id',          l.id,
    'refCode',     l.ref_code,
    'occurredAt',  l.occurred_at,
    'createdAt',   l.created_at,
    'severity',    l.severity,
    'tenantId',    l.tenant_id,
    'tenantName',  t.name,
    'userId',      l.user_id,
    'userEmail',   u.email,
    'screen',      l.screen,
    'action',      l.action,
    'message',     l.message,
    'detail',      l.detail,
    'userMessage', l.user_message,
    'context',     l.context,
    'appVersion',  l.app_version,
    'platform',    l.platform,
    'osVersion',   l.os_version
  ) into v_row
  from public.error_logs l
  left join public.tenants t on t.id = l.tenant_id
  left join auth.users   u on u.id = l.user_id
  where l.id = p_id;

  return v_row; -- null quando não existe
end; $$;

-- Retenção: o log é diagnóstico, não histórico permanente. Purga por idade.
create or replace function public.admin_run_error_logs_cleanup(p_days integer default 90)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_days    integer := coalesce(p_days, 90);
  v_deleted integer;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  if v_days <= 0 then
    raise exception 'retenção inválida: informe um número de dias maior que zero';
  end if;

  delete from public.error_logs where occurred_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('retentionDays', v_days, 'deletedCount', v_deleted);
end; $$;

grant execute on function public.admin_list_error_logs(uuid, text, text, integer, integer) to authenticated;
grant execute on function public.admin_error_log_detail(uuid) to authenticated;
grant execute on function public.admin_run_error_logs_cleanup(integer) to authenticated;

-- =====================================================================
-- VERIFICAÇÃO (opcional)
--   select count(*) from public.error_logs;
--   select public.admin_list_error_logs(null, null, null, 20, 0);   -- como admin
--   select public.admin_run_error_logs_cleanup(90);
--
-- AGENDAMENTO (opcional, requer pg_cron habilitado) — limpeza mensal:
--   select cron.schedule(
--     'cleanup-error-logs', '0 4 1 * *',
--     $$delete from public.error_logs where occurred_at < now() - interval '90 days';$$
--   );
-- =====================================================================
