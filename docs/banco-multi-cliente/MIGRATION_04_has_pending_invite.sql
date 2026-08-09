-- =====================================================================
-- MIGRATION 04 — RPC pública has_pending_invite(email)
-- Aplica SOBRE MIGRATION_02_invites_table.sql. Idempotente.
--
-- MOTIVAÇÃO (UX do cadastro):
--   A tela de cadastro precisa saber, ANTES do login, se o e-mail digitado tem
--   um convite pendente — para ocultar/desobrigar o campo "nome da empresa"
--   (convidado entra numa empresa existente; usuário novo cria a própria).
--   Como tenant_invites tem RLS (só membros leem) e quem se cadastra ainda não
--   está autenticado, expomos uma RPC SECURITY DEFINER que devolve APENAS um
--   booleano (não vaza tenant, papel, nem quem convidou).
--
-- NOTA DE SEGURANÇA: isto permite a um anônimo checar se um e-mail tem convite
--   pendente (pequena superfície de enumeração). É aceitável pelo baixo valor do
--   dado exposto (só existe/não existe) e pelo ganho de UX.
-- =====================================================================

create or replace function public.has_pending_invite(p_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_invites ti
    where lower(ti.email) = lower(coalesce(p_email, ''))
      and ti.status = 'pending'
      and ti.expires_at > now()
  );
$$;

grant execute on function public.has_pending_invite(text) to anon, authenticated;
