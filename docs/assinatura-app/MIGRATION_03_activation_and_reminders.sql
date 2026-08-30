-- =====================================================================
-- Sir Barbecue — MIGRATION 03 (licenciamento): ativar assinatura,
-- carência de 48h no vencimento e lembrete automático de vencimento
-- por e-mail (5 dias antes).
--
-- Adiciona:
--   - subscriptions.due_reminder_sent_for : para qual current_period_end
--     já foi disparado o lembrete (evita reenvio).
--   - admin_activate_tenant_subscription(p_tenant_id) : status='active' +
--     current_period_end = now() + 1 mês. Funciona a partir de trial,
--     past_due ou canceled (reativação).
--   - get_access_status(): carência de 48h após current_period_end antes
--     de bloquear (só no ramo status='active'; trial inalterado).
--   - send_subscription_due_reminders() + wrapper admin
--     admin_run_subscription_due_reminders_now() : varre assinaturas
--     ativas a até 5 dias do vencimento e dispara e-mail via Edge
--     Function send-subscription-reminder (pg_net), usando um token
--     guardado no Supabase Vault (ver instruções no fim do arquivo).
--
-- Pré-requisito: docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql já
-- aplicado (is_platform_admin(), subscriptions, tenants.owner_user_id).
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente (add column if not exists + create or replace function).
-- =====================================================================

begin;

-- 1) Nova coluna: para qual vencimento o lembrete já foi enviado.
alter table public.subscriptions
  add column if not exists due_reminder_sent_for timestamptz;

-- 2) Ativar assinatura (trial/past_due/canceled → active), vencimento =
--    hoje + 1 mês.
create or replace function public.admin_activate_tenant_subscription(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  update public.subscriptions
     set status = 'active',
         current_period_end = now() + interval '1 month',
         updated_at = now()
   where tenant_id = p_tenant_id;
  if not found then
    raise exception 'assinatura não encontrada para a empresa %', p_tenant_id;
  end if;
end; $$;
grant execute on function public.admin_activate_tenant_subscription(uuid) to authenticated;

-- 3) get_access_status: carência de 48h após current_period_end antes de
--    bloquear quem está 'active'. endsAt/daysRemaining continuam
--    refletindo o vencimento real (v_ends não muda) — só o bloqueio
--    atrasa. Ramo 'trial' inalterado (sem carência).
create or replace function public.get_access_status(p_tenant_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid;
  v_sub     public.subscriptions;
  v_allowed boolean := false;
  v_reason  text;
  v_ends    timestamptz;
  v_days    int := 0;
begin
  if p_tenant_id is not null then
    if not (p_tenant_id in (select public.user_tenant_ids())) then
      return jsonb_build_object('allowed', false, 'status', null, 'reason', 'forbidden',
                                'endsAt', null, 'daysRemaining', 0);
    end if;
    v_tenant := p_tenant_id;
  else
    select tid into v_tenant from (select public.user_tenant_ids() as tid) s limit 1;
  end if;

  if v_tenant is null then
    return jsonb_build_object('allowed', false, 'status', null, 'reason', 'no_tenant',
                              'endsAt', null, 'daysRemaining', 0);
  end if;

  select * into v_sub from public.subscriptions where tenant_id = v_tenant;
  if not found then
    return jsonb_build_object('allowed', false, 'status', null, 'reason', 'no_subscription',
                              'endsAt', null, 'daysRemaining', 0);
  end if;

  if v_sub.blocked_by_owner then
    v_allowed := false; v_reason := 'blocked_by_owner';
  elsif v_sub.status = 'canceled' then
    v_allowed := false; v_reason := 'canceled';
  elsif v_sub.status = 'past_due' then
    v_allowed := false; v_reason := 'payment_overdue'; v_ends := v_sub.current_period_end;
  elsif v_sub.status = 'trial' then
    v_ends := v_sub.trial_ends_at;
    if v_ends is not null and now() >= v_ends then
      v_allowed := false; v_reason := 'trial_expired';
    else
      v_allowed := true; v_reason := 'trial';
    end if;
  elsif v_sub.status = 'active' then
    v_ends := v_sub.current_period_end;
    -- Carência de 48h: só bloqueia 2 dias depois do vencimento real.
    if v_ends is not null and now() >= v_ends + interval '48 hours' then
      v_allowed := false; v_reason := 'payment_overdue';
    else
      v_allowed := true; v_reason := 'active';
    end if;
  else
    v_allowed := false; v_reason := 'unknown';
  end if;

  if v_ends is not null then
    v_days := greatest(0, ceil(extract(epoch from (v_ends - now())) / 86400))::int;
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'status', v_sub.status,
    'reason', v_reason,
    'endsAt', v_ends,
    'daysRemaining', v_days
  );
end; $$;

-- 4) Lembrete automático de vencimento (5 dias antes, janela 0-5 pra
--    tolerar uma falha do cron sem perder o aviso; due_reminder_sent_for
--    garante só um e-mail por vencimento).
create or replace function public.send_subscription_due_reminders()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_token text;
begin
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'subscription_reminder_token';
  if v_token is null then
    raise notice 'subscription_reminder_token não configurado no Vault — abortando envio.';
    return;
  end if;

  for r in
    select s.tenant_id, t.name as tenant_name, s.current_period_end, u.email
    from public.subscriptions s
    join public.tenants t on t.id = s.tenant_id
    join auth.users u on u.id = t.owner_user_id
    where s.status = 'active'
      and s.current_period_end is not null
      and u.email is not null
      and s.due_reminder_sent_for is distinct from s.current_period_end
      and (s.current_period_end at time zone 'America/Sao_Paulo')::date
          - (now() at time zone 'America/Sao_Paulo')::date between 0 and 5
  loop
    perform net.http_post(
      url     := 'https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/send-subscription-reminder?token=' || v_token,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := jsonb_build_object('email', r.email, 'tenantName', r.tenant_name, 'dueDate', r.current_period_end)
    );
    update public.subscriptions set due_reminder_sent_for = r.current_period_end
     where tenant_id = r.tenant_id;
  end loop;
end; $$;
revoke execute on function public.send_subscription_due_reminders() from public, authenticated, anon;

-- Pra testar sem esperar o cron (chamável pelo dono via SQL Editor/painel).
create or replace function public.admin_run_subscription_due_reminders_now()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  perform public.send_subscription_due_reminders();
end; $$;
grant execute on function public.admin_run_subscription_due_reminders_now() to authenticated;

commit;

-- =====================================================================
-- PASSOS MANUAIS (fora da transação acima)
-- =====================================================================
-- 1) Segredo do lembrete no Vault (gere um token aleatório longo, mesmo
--    valor vai como secret SUBSCRIPTION_REMINDER_TOKEN da Edge Function):
--      select vault.create_secret('<token aleatório longo>', 'subscription_reminder_token');
--
-- 2) Agendamento (pg_cron) — requer habilitar a extensão em Supabase
--    Dashboard → Database → Extensions ANTES de descomentar:
--      select cron.schedule(
--        'send-subscription-due-reminders',
--        '0 12 * * *',  -- 12:00 UTC = 09:00 America/Sao_Paulo (sem horário de verão)
--        $$select public.send_subscription_due_reminders();$$
--      );
--
-- 3) Deploy da Edge Function (fora do Postgres):
--      supabase secrets set SUBSCRIPTION_REMINDER_TOKEN="<mesmo token do passo 1>"
--      supabase secrets set RESEND_API_KEY="re_xxx..."
--      supabase secrets set EMAIL_FROM="Sir Barbecue <assinatura@seu-dominio>"
--      supabase functions deploy send-subscription-reminder --no-verify-jwt
--
-- =====================================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO
-- =====================================================================
-- select public.admin_activate_tenant_subscription('<tenant>');
-- select status, current_period_end, contract_started_at from public.subscriptions where tenant_id = '<tenant>';
--
-- -- Carência de 48h:
-- update public.subscriptions set current_period_end = now() - interval '1 hour' where tenant_id = '<tenant>';
-- select public.get_access_status('<tenant>');  -- ainda allowed=true (dentro da carência)
-- update public.subscriptions set current_period_end = now() - interval '49 hours' where tenant_id = '<tenant>';
-- select public.get_access_status('<tenant>');  -- allowed=false, reason=payment_overdue
--
-- -- Lembrete (após configurar Vault + secrets + deploy da function):
-- update public.subscriptions set current_period_end = now() + interval '3 days', due_reminder_sent_for = null
--   where tenant_id = '<tenant>';
-- select public.admin_run_subscription_due_reminders_now();
-- select due_reminder_sent_for from public.subscriptions where tenant_id = '<tenant>';  -- deve estar preenchido
-- =====================================================================
