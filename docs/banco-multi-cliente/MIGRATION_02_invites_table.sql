-- =====================================================================
-- MIGRATION 02 — Convites como tabela real (fonte da verdade no servidor)
-- Aplica SOBRE SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql + MIGRATION_01_invite_trigger.sql.
-- Idempotente (create or replace / if not exists / drop policy if exists).
--
-- MOTIVAÇÃO (correção CRÍTICA):
--   Os triggers da MIGRATION_01 confiavam em raw_user_meta_data->>'invited_to_tenant'
--   e 'invited_role' para criar a membership no cadastro. Esses metadados vêm do
--   options.data do supabase.auth.signUp — TOTALMENTE CONTROLÁVEIS pelo cliente com
--   a anon key pública. Um atacante que conheça um tenant_id podia se auto-registrar
--   como OWNER de qualquer empresa (escalonamento de privilégio cross-tenant).
--
--   Correção: o vínculo do convidado passa a ser resolvido por uma tabela de
--   convites (tenant_invites), gravada APENAS pela Edge Function invite-member
--   (service_role, com validação de owner). O trigger ignora qualquer metadado de
--   tenant/role do signup e resolve o convite pelo E-MAIL do novo usuário.
--   'owner' nunca é concedido por convite — owner só na criação da própria empresa.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) Tabela de convites
-- ---------------------------------------------------------------------
create table if not exists public.tenant_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  email       text not null,
  role        varchar(20) not null default 'employee' check (role in ('manager','employee')),
  status      varchar(20) not null default 'pending'  check (status in ('pending','accepted','revoked')),
  invited_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz
);

create index if not exists idx_tenant_invites_email on public.tenant_invites (lower(email));
-- No máximo 1 convite PENDENTE por (empresa, e-mail).
create unique index if not exists uq_tenant_invites_pending
  on public.tenant_invites (tenant_id, lower(email))
  where status = 'pending';

-- ---------------------------------------------------------------------
-- (2) RLS — leitura só para membros da empresa; escrita SÓ via service_role
--     (a Edge Function invite-member). Nenhuma policy de INSERT/UPDATE/DELETE
--     para 'authenticated' → cliente não grava/edita convites diretamente.
-- ---------------------------------------------------------------------
alter table public.tenant_invites enable row level security;

drop policy if exists invites_select on public.tenant_invites;
create policy invites_select on public.tenant_invites
  for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));

-- ---------------------------------------------------------------------
-- (3) handle_new_user — cria a 1ª empresa APENAS se o e-mail NÃO tem convite
--     pendente. (Antes: pulava quando havia o metadado 'invited_to_tenant'.)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
begin
  -- Convidado por uma empresa existente (há convite pendente para este e-mail)
  -- → não cria empresa própria; a membership é criada por handle_new_user_invite.
  if exists (
    select 1 from public.tenant_invites ti
    where lower(ti.email) = lower(new.email)
      and ti.status = 'pending'
      and ti.expires_at > now()
  ) then
    return new;
  end if;

  insert into public.tenants (name, owner_user_id)
    values (coalesce(nullif(new.raw_user_meta_data->>'business_name',''), 'Minha Empresa'), new.id)
    returning id into v_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant_id, new.id, 'owner')
  on conflict (tenant_id, user_id) do nothing;

  return new;
end; $$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- (4) handle_new_user_invite — resolve o vínculo pela TABELA de convites,
--     ignorando qualquer metadado do signup. Consome o convite (accepted).
--     Roda DEPOIS de handle_new_user (ordem alfabética das triggers).
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_invite record;
begin
  select ti.* into v_invite
  from public.tenant_invites ti
  where lower(ti.email) = lower(new.email)
    and ti.status = 'pending'
    and ti.expires_at > now()
  order by ti.created_at desc
  limit 1;

  if v_invite.id is null then
    return new; -- sem convite legítimo → NENHUMA membership é criada
  end if;

  -- role vem da tabela (garantidamente manager/employee, nunca owner).
  insert into public.tenant_members (tenant_id, user_id, role)
    values (v_invite.tenant_id, new.id, v_invite.role)
  on conflict (tenant_id, user_id) do nothing;

  update public.tenant_invites
    set status = 'accepted', accepted_at = now()
    where id = v_invite.id;

  return new;
end; $$;

drop trigger if exists trg_handle_new_user_invite on auth.users;
create trigger trg_handle_new_user_invite
  after insert on auth.users
  for each row execute function public.handle_new_user_invite();
