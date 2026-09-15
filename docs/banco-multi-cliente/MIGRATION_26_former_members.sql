-- =====================================================================
-- MIGRATION 26 — O funcionário que sobrevive à exclusão da empresa
-- Aplica SOBRE MIGRATION_24 (delete_tenant_cascade, worker horário) e
-- MIGRATION_25 (fila de exportação). Idempotente.
-- Plano: docs/exportacao-dados/PLANO_FUNCIONARIO_ORFAO.md
--
-- PROBLEMA (descoberto em 15/09/2026, no teste real da exclusão agendada):
--   Quando a empresa é excluída, `tenant_members.tenant_id ... on delete cascade`
--   HARD-DELETA a linha de cada funcionário. A conta de Auth dele continua viva —
--   e deve mesmo continuar: ele é o titular dos dados pessoais dele, e a empresa
--   não tem o direito de apagar a conta de outra pessoa.
--
--   Só que não sobra rastro NENHUM: nem `removed_at`. Do lado do cliente,
--   `resolveMembership` vê zero linhas e devolve `membershipStatus = 'none'` —
--   o mesmo estado de quem NUNCA foi convidado. O app então mostra "peça ao
--   administrador que envie um convite", sendo que:
--     • o administrador não existe mais (a empresa foi apagada);
--     • o convite NUNCA enviou e-mail (ver invite-member/index.ts:149-153).
--   O funcionário fica preso numa tela de um botão só ("Sair"), sem conseguir
--   exercer nenhum direito sobre a própria conta.
--
-- O QUE MUDA:
--   1. `former_members` registra o desvínculo ANTES de a empresa sumir.
--   2. `my_membership_status()` deixa o app distinguir as três situações que hoje
--      colapsam em 'none': nunca convidado / inativado pelo dono / empresa encerrada.
--   3. O worker horário ganha uma terceira fila: avisar o ex-membro por e-mail e,
--      passados 6 meses sem vínculo, encerrar a conta órfã (com aviso prévio).
--
-- DECISÕES:
--   • `former_members` guarda o MÍNIMO: user_id + motivo + data. SEM o nome da
--     empresa. Guardar "você trabalhava na Empresa X" depois de a Empresa X pedir
--     a eliminação seria reter justamente o dado que ela mandou apagar. O
--     funcionário precisa saber O QUE aconteceu, não DE QUEM.
--   • FK para auth.users com ON DELETE CASCADE. Isto CONTRARIA a doutrina da
--     MIGRATION_21 ("não ancorar trilha em tabela que a lei manda apagar") — e é
--     deliberado: aquela regra vale para tabelas de AUTORIA, que precisam
--     sobreviver à saída da pessoa. Esta aqui é metadado DO PRÓPRIO usuário e
--     deve morrer junto com ele.
--   • O registro é gravado DENTRO da transação do delete_tenant_cascade, antes do
--     `delete from tenants`. Se o e-mail de aviso falhasse e não houvesse este
--     registro, não haveria como reconstruir a lista de membros: ela morre com o
--     cascade. Assim o envio pode ser retentado.
--   • Uma linha por usuário (unique + upsert): quem ficar órfão duas vezes tem a
--     data renovada, não duplicada.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) former_members — o rastro que o cascade não deixava
-- ---------------------------------------------------------------------
create table if not exists public.former_members (
  id              uuid primary key default gen_random_uuid(),
  -- CASCADE: se a pessoa excluir a própria conta, este registro vai junto.
  user_id         uuid not null unique references auth.users (id) on delete cascade,
  reason          text not null default 'tenant_deleted'
                  check (reason in ('tenant_deleted')),
  occurred_at     timestamptz not null default now(),
  -- Aviso "a empresa encerrou; sua conta continua sua".
  notified_at     timestamptz,
  -- Aviso "faltam 15 dias para encerrarmos sua conta".
  warning_sent_at timestamptz,
  purge_after     timestamptz not null,
  purged_at       timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.former_members is
  'Usuários que perderam o vínculo porque a EMPRESA foi excluída (o cascade apaga tenant_members sem deixar removed_at). Guarda o mínimo: quem e quando, nunca o nome da empresa.';

create index if not exists idx_former_members_purge on public.former_members (purge_after);

alter table public.former_members enable row level security;

-- O usuário lê o próprio registro — é o que alimenta a tela de bloqueio.
-- Sem policy de escrita: só RPC security definer e service_role.
drop policy if exists former_members_self_read on public.former_members;
create policy former_members_self_read on public.former_members
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2) delete_tenant_cascade — sexta versão (18→19→21→22→24→26)
-- ---------------------------------------------------------------------
-- Idêntica à da MIGRATION_24, com o passo 6.6 novo. A ordem importa: os membros
-- são lidos ANTES do `delete from tenants`, porque o cascade os destrói.
create or replace function public.delete_tenant_cascade(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) Itens de venda e de comanda.
  delete from public.sale_items si
   using public.sales s
   where s.client_id = si.sale_client_id and s.tenant_id = p_tenant_id;

  delete from public.tab_items ti
   using public.tabs t
   where t.client_id = ti.tab_client_id and t.tenant_id = p_tenant_id;

  -- 2) Filhas diretas de products / suppliers.
  delete from public.product_day_visibility pdv
   using public.products pr
   where pr.client_id = pdv.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_supplier_price_history h
   using public.products pr
   where pr.client_id = h.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.products pr
   where pr.client_id = ps.product_client_id and pr.tenant_id = p_tenant_id;

  delete from public.product_suppliers ps
   using public.suppliers su
   where su.client_id = ps.supplier_client_id and su.tenant_id = p_tenant_id;

  -- 3) Tabelas com tenant_id que apontam para products/suppliers.
  delete from public.stock_items   where tenant_id = p_tenant_id;
  delete from public.stock_entries where tenant_id = p_tenant_id;

  -- 4) Vendas e comandas.
  delete from public.sales where tenant_id = p_tenant_id;
  delete from public.tabs  where tenant_id = p_tenant_id;

  -- 5) Catálogo.
  delete from public.products   where tenant_id = p_tenant_id;
  delete from public.suppliers  where tenant_id = p_tenant_id;
  delete from public.categories where tenant_id = p_tenant_id;

  -- 6) Relatórios e exportações ANTES da empresa (referenciam tenant_members,
  --    que cascateia do mesmo delete — MIGRATION_18).
  delete from public.reports      where tenant_id = p_tenant_id;
  delete from public.data_exports where tenant_id = p_tenant_id;

  -- 6.5) A solicitação NÃO é apagada: vira histórico de atendimento no painel.
  update public.account_deletion_requests
     set status       = 'completed',
         completed_at = coalesce(completed_at, now()),
         updated_at   = now()
   where tenant_id = p_tenant_id
     and status in ('pending', 'failed');

  -- O contato some de TODAS as solicitações desta empresa, inclusive das
  -- CANCELADAS: a razão de guardar nome e telefone era ligar para o cliente
  -- durante a janela; com a empresa apagada não há mais para quem ligar.
  update public.account_deletion_requests
     set contact_name      = null,
         contact_phone     = null,
         contact_email     = null,
         contact_erased_at = coalesce(contact_erased_at, now()),
         updated_at        = now()
   where tenant_id = p_tenant_id
     and contact_erased_at is null;

  -- 6.6) MIGRATION_26 — registra quem PERDE o vínculo por esta exclusão.
  --      Tem de ser aqui, antes do delete de tenants: o cascade apaga
  --      tenant_members e a lista de membros deixa de existir. O dono não entra
  --      (a conta dele é apagada logo em seguida pelo worker) e o registro NÃO
  --      guarda o nome da empresa — ver DECISÕES no cabeçalho.
  --
  --      `removed_at is null` de propósito: quem JÁ havia sido inativado pelo
  --      dono antes da exclusão não entra. Ele perdeu o acesso dias antes, já
  --      sabe por quê, e não vai esbarrar num app quebrado — mandar um e-mail
  --      contando que a ex-empresa encerrou a conta seria ruído, e ainda contaria
  --      a um ex-funcionário algo sobre o antigo patrão. Efeito colateral aceito:
  --      a linha dele (com removed_at) também morre no cascade, então o
  --      my_membership_status() dele passa de 'removed' para 'never' — que
  --      continua sendo verdade, já que ele não está em empresa nenhuma.
  insert into public.former_members (user_id, reason, occurred_at, purge_after)
  select tm.user_id, 'tenant_deleted', now(), now() + interval '6 months'
    from public.tenant_members tm
    join public.tenants t on t.id = tm.tenant_id
   where tm.tenant_id = p_tenant_id
     and tm.removed_at is null
     and tm.user_id <> t.owner_user_id
  on conflict (user_id) do update
     set occurred_at     = now(),
         purge_after     = now() + interval '6 months',
         reason          = 'tenant_deleted',
         notified_at     = null,
         warning_sent_at = null,
         updated_at      = now();

  -- 7) O resto cascateia de tenants.
  delete from public.tenants where id = p_tenant_id;
end;
$$;

revoke execute on function public.delete_tenant_cascade(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) my_membership_status — por que estou sem empresa?
-- ---------------------------------------------------------------------
-- Hoje o app não distingue TRÊS situações que colapsam no mesmo 'none':
--   • nunca convidado                -> nenhuma linha em lugar nenhum
--   • inativado pelo dono            -> tenant_members com removed_at (a RLS
--     esconde do cliente; aqui, SECURITY DEFINER, enxergamos)
--   • empresa encerrada              -> linha em former_members
-- Quando as duas últimas existem (saiu de uma empresa e outra foi encerrada),
-- vence a MAIS RECENTE — é a que explica a situação atual dele.
create or replace function public.my_membership_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_removed timestamptz;
  v_former  public.former_members;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'none', 'reason', 'never');
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  if exists (
    select 1 from public.tenant_members
     where user_id = v_uid and removed_at is null
  ) then
    return jsonb_build_object('status', 'member', 'reason', null, 'email', v_email);
  end if;

  select max(removed_at) into v_removed
    from public.tenant_members where user_id = v_uid;

  select * into v_former from public.former_members where user_id = v_uid;

  if v_former.user_id is not null
     and (v_removed is null or v_former.occurred_at >= v_removed) then
    return jsonb_build_object(
      'status',     'none',
      'reason',     'tenant_deleted',
      'occurredAt', v_former.occurred_at,
      'purgeAfter', v_former.purge_after,
      'email',      v_email
    );
  end if;

  if v_removed is not null then
    return jsonb_build_object(
      'status', 'none', 'reason', 'removed', 'occurredAt', v_removed, 'email', v_email
    );
  end if;

  return jsonb_build_object('status', 'none', 'reason', 'never', 'email', v_email);
end;
$$;

revoke all on function public.my_membership_status() from public, anon;
grant execute on function public.my_membership_status() to authenticated;

-- ---------------------------------------------------------------------
-- 4) O cron passa a acordar também pela fila de órfãos
-- ---------------------------------------------------------------------
create or replace function public.run_due_account_deletions()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_token     text;
  v_last_day  date;
begin
  -- Alarme de calendário: a semeadura de feriados acaba em 2036. Sem este aviso,
  -- o prazo de 10 dias úteis volta a ignorar feriados em silêncio.
  select max(day) into v_last_day from public.holidays;
  if v_last_day is null or v_last_day < (current_date + interval '1 year')::date then
    raise warning 'public.holidays semeada só até %: rode seed_br_holidays para os próximos anos', v_last_day;
  end if;

  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'deletion_worker_token';

  if v_token is null then
    raise notice 'deletion_worker_token ausente no Vault: nada a fazer';
    return;
  end if;

  -- Só bate na Edge Function se houver trabalho em ALGUMA das três filas.
  if not exists (
    select 1 from public.account_deletion_requests
     where status = 'pending' and scheduled_for <= now()
  ) and not exists (
    select 1 from public.data_exports where status = 'pending'
  ) and not exists (
    select 1 from public.former_members
     where purged_at is null
       and (notified_at is null
            or (warning_sent_at is null and purge_after - interval '15 days' <= now())
            or purge_after <= now())
  ) then
    return;
  end if;

  perform net.http_post(
    url     := 'https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/process-deletion-requests?token=' || v_token,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('source', 'cron')
  );
end; $$;

revoke execute on function public.run_due_account_deletions() from public, authenticated, anon;

commit;

-- =====================================================================
-- VERIFICAÇÃO (PÓS-MIGRAÇÃO)
-- =====================================================================
-- 1) Tabela, índice e policy existem?
--    select column_name from information_schema.columns where table_name='former_members' order by 1;
--    select policyname, cmd from pg_policies where tablename='former_members';
--
-- 2) O passo 6.6 entrou no cascade?
--    select pg_get_functiondef('public.delete_tenant_cascade(uuid)'::regprocedure) like '%former_members%';
--
-- TESTE FUNCIONAL (empresa de teste com owner + 2 funcionários):
--   a) select public.delete_tenant_cascade('<tenant>');
--      -> 2 linhas em former_members (os funcionários), o OWNER não entra:
--      select user_id, reason, purge_after from public.former_members;
--   b) my_membership_status() pela API, com o token de cada perfil:
--      funcionário órfão -> reason 'tenant_deleted' + purgeAfter;
--      membro inativado  -> reason 'removed';
--      usuário novo      -> reason 'never';
--      membro ativo      -> status 'member'.
--   c) vincular o órfão a outra empresa -> my_membership_status() volta a 'member'
--      e a fila de purga passa a ignorá-lo (o worker confere o vínculo na hora).
