-- =====================================================================
-- MIGRATION 07 — Histórico de quedas do sistema (health_events)
-- Aplica SOBRE a MIGRATION_06 (endpoint /health). Idempotente.
-- Rode no Supabase → SQL Editor → New query → cole tudo → Run.
--
--  • O /health responde "está no ar AGORA". Esta tabela responde a outra pergunta:
--    "caiu de madrugada? por quanto tempo? quantas vezes esse mês?".
--  • Quem sabe da queda é o monitor EXTERNO (HetrixTools) — não o Supabase, que
--    quando cai não consegue registrar a própria queda. O monitor manda um webhook
--    para a Edge Function `health-webhook`, que grava aqui.
--  • É dado de PLATAFORMA, não de cliente: não tem tenant_id. Só o dono da
--    aplicação lê (painel admin), no mesmo padrão de error_logs (MIGRATION_05).
-- =====================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1) TABELA
-- ---------------------------------------------------------------------
create table if not exists public.health_events (
  id             uuid primary key default gen_random_uuid(),
  monitor_id     text,                                  -- id do monitor no HetrixTools
  monitor_name   text not null,
  monitor_target text,                                  -- a URL monitorada
  status         varchar(10) not null
                 check (status in ('online', 'offline')),
  occurred_at    timestamptz not null,                  -- horário do evento no monitor
  -- Motivos por localidade quando cai: ["timeout", "keyword not found", "HTTP 503"]
  errors         jsonb not null default '[]'::jsonb,
  raw            jsonb,                                 -- payload cru, para depurar
  created_at     timestamptz not null default now()
);

create index if not exists health_events_occurred_at_idx
  on public.health_events (occurred_at desc);

-- Idempotência: o monitor pode reenviar o mesmo webhook (retry). Sem isto, uma
-- reentrega vira "incidente" duplicado e distorce o uptime.
create unique index if not exists health_events_dedup_idx
  on public.health_events (coalesce(monitor_id, ''), status, occurred_at);

-- ---------------------------------------------------------------------
-- 2) RLS — leitura só do dono da aplicação; escrita só pela Edge Function
-- ---------------------------------------------------------------------
alter table public.health_events enable row level security;

drop policy if exists health_events_admin_read on public.health_events;
create policy health_events_admin_read on public.health_events
  for select to authenticated
  using (public.is_platform_admin());

-- Sem policy de INSERT de propósito: quem grava é a `health-webhook` com a
-- service_role (que ignora RLS). Nenhum usuário logado consegue forjar uma queda.

-- ---------------------------------------------------------------------
-- 3) RPCs do painel admin
-- ---------------------------------------------------------------------

-- Lista dos últimos eventos (chaves em camelCase, como as demais RPCs admin_*).
create or replace function public.admin_list_health_events(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  return coalesce((
    select jsonb_agg(row_obj order by row_obj->>'occurredAt' desc)
    from (
      select jsonb_build_object(
        'id',          e.id,
        'monitorName', e.monitor_name,
        'status',      e.status,
        'occurredAt',  e.occurred_at,
        'errors',      e.errors
      ) as row_obj
      from public.health_events e
      order by e.occurred_at desc
      limit v_limit
    ) s
  ), '[]'::jsonb);
end; $$;

-- Resumo do período: estado atual, nº de quedas, tempo fora e uptime %.
-- Cada 'offline' é fechado pelo 'online' seguinte; se ainda não voltou, conta
-- até agora (incidente em aberto).
create or replace function public.admin_health_summary(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_days       integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from       timestamptz := now() - make_interval(days => v_days);
  v_last       record;
  v_incidents  integer := 0;
  v_down_secs  numeric := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  -- Estado atual = último evento registrado (de qualquer data).
  select e.status, e.occurred_at into v_last
  from public.health_events e
  order by e.occurred_at desc
  limit 1;

  -- Quedas e tempo fora dentro da janela: cada 'offline' dura até o evento
  -- seguinte (o 'online' que o fechou) ou até agora, se ainda não voltou.
  with ev as (
    select
      e.status,
      e.occurred_at,
      lead(e.occurred_at) over (order by e.occurred_at) as next_at
    from public.health_events e
    where e.occurred_at >= v_from
  )
  select
    count(*),
    coalesce(sum(extract(epoch from (coalesce(next_at, now()) - occurred_at))), 0)
    into v_incidents, v_down_secs
  from ev
  where status = 'offline';

  return jsonb_build_object(
    'days',            v_days,
    'currentStatus',   coalesce(v_last.status, 'unknown'),
    'since',           v_last.occurred_at,
    'incidents',       coalesce(v_incidents, 0),
    'downtimeMinutes', round(coalesce(v_down_secs, 0) / 60.0, 1),
    'uptimePercent',   round(
      greatest(0, 100 - (coalesce(v_down_secs, 0) / (v_days * 86400.0) * 100))::numeric, 4
    )
  );
end; $$;

grant execute on function public.admin_list_health_events(integer) to authenticated;
grant execute on function public.admin_health_summary(integer) to authenticated;

-- =====================================================================
-- VERIFICAÇÃO
--   select public.admin_health_summary(30);        -- como admin
--   select public.admin_list_health_events(20);
--
-- SIMULAR UM INCIDENTE (para ver o painel preenchido antes da 1ª queda real):
--   insert into public.health_events (monitor_name, status, occurred_at, errors)
--   values ('Sir Barbecue Backend', 'offline', now() - interval '20 min', '["timeout"]'),
--          ('Sir Barbecue Backend', 'online',  now() - interval '13 min', '[]');
--   -- para desfazer: delete from public.health_events where monitor_name = 'Sir Barbecue Backend';
-- =====================================================================
