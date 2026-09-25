-- =====================================================================
-- MIGRATION 31 — Equipe mostra nome/e-mail em vez do UUID
-- Idempotente.
--
-- MOTIVAÇÃO:
--   A tela "Minha Empresa" listava cada membro da equipe como os 8 primeiros
--   caracteres do UUID (`c8d0056f…`) porque `fetchMembers` lê direto de
--   tenant_members, que só tem user_id/role — nome e e-mail moram em
--   auth.users, e um usuário comum não consegue ler a linha de OUTRO ali (sem
--   RLS liberando isso, por padrão do Supabase).
--
-- DECISÃO:
--   Função nova, SECURITY DEFINER, com a MESMA trava de quem já pode abrir a
--   tela "Minha Empresa" no app (owner ou manager — is_tenant_owner_or_manager,
--   já existente desde a MIGRATION_21). Ela junta tenant_members com
--   auth.users e devolve e-mail + nome (metadata do cadastro, se houver) só
--   dos membros da MESMA empresa do chamador — nunca de outro tenant.
-- =====================================================================

create or replace function public.list_tenant_members(p_tenant_id uuid)
returns table (
  user_id      uuid,
  role         varchar(20),
  removed_at   timestamptz,
  email        text,
  display_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_tenant_owner_or_manager(p_tenant_id) then
    raise exception 'sem permissão para ver a equipe desta empresa';
  end if;

  return query
    select
      tm.user_id,
      tm.role,
      tm.removed_at,
      u.email::text,
      coalesce(u.raw_user_meta_data->>'name', u.raw_user_meta_data->>'full_name') as display_name
    from public.tenant_members tm
    join auth.users u on u.id = tm.user_id
   where tm.tenant_id = p_tenant_id;
end;
$$;

comment on function public.list_tenant_members(uuid) is
  'Equipe da empresa com nome/e-mail (join com auth.users, que o app não lê direto). Só owner/manager da empresa pode chamar.';

revoke all on function public.list_tenant_members(uuid) from public;
grant execute on function public.list_tenant_members(uuid) to authenticated;
