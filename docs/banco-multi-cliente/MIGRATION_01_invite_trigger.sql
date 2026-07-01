-- =====================================================================
-- MIGRATION 01 — Convite de membro para empresa existente
-- Aplica SOBRE o SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql (já implantado).
-- Idempotente (create or replace / drop trigger if exists) — seguro rodar no SQL Editor.
--
-- Resultado:
--  • Usuário NORMAL (cadastro pela app) → cria a 1ª empresa (comportamento inalterado).
--  • Usuário CONVIDADO por uma empresa existente → entra NA empresa que convidou,
--    sem criar empresa própria.
-- Distinção feita pelo metadado raw_user_meta_data->>'invited_to_tenant',
-- preenchido pela Edge Function invite-member ao chamar inviteUserByEmail.
-- =====================================================================

-- (1) handle_new_user — INALTERADO para usuários normais; ganha apenas uma GUARDA
--     que pula a criação de empresa quando o usuário foi convidado.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
begin
  -- Convidado por uma empresa existente → não cria empresa própria
  -- (a membership é criada por handle_new_user_invite).
  if (new.raw_user_meta_data ? 'invited_to_tenant') then
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

-- (2) handle_new_user_invite — NOVO. Só age para usuário convidado: vincula-o à
--     empresa que convidou, com o papel do convite (default 'employee').
create or replace function public.handle_new_user_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_role text;
begin
  if (new.raw_user_meta_data ? 'invited_to_tenant') then
    v_tenant_id := (new.raw_user_meta_data->>'invited_to_tenant')::uuid;
    v_role := coalesce(nullif(new.raw_user_meta_data->>'invited_role',''), 'employee');
    if v_role not in ('owner','manager','employee') then
      v_role := 'employee';
    end if;

    insert into public.tenant_members (tenant_id, user_id, role)
      values (v_tenant_id, new.id, v_role)
    on conflict (tenant_id, user_id) do nothing;
  end if;
  return new;
end; $$;

drop trigger if exists trg_handle_new_user_invite on auth.users;
create trigger trg_handle_new_user_invite
  after insert on auth.users
  for each row execute function public.handle_new_user_invite();
