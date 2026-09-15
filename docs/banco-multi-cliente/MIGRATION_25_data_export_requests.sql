-- =====================================================================
-- MIGRATION 25 — Exportação de dados vira SOLICITAÇÃO assíncrona
-- Aplica SOBRE MIGRATION_22 (data_exports, bucket exports) e MIGRATION_24
-- (worker horário, trilha de entrega do Resend). Idempotente.
-- Plano: docs/exportacao-dados/PLANO_EXCLUSAO_AGENDADA.md
--
-- PROBLEMA:
--   A exportação self-service é SÍNCRONA: o cliente toca no botão e espera o
--   servidor varrer o banco, montar o .zip, subir no Storage e assinar a URL —
--   e então baixa o arquivo inteiro pelo 4G. Num PDV de celular isso é caro em
--   dois lugares ao mesmo tempo: na janela de requisição da Edge Function e no
--   aparelho do cliente, que fica travado esperando.
--
-- O QUE MUDA:
--   O app deixa de baixar e passa a SOLICITAR. A linha nasce em `data_exports`
--   com status 'pending' e entra na fila do mesmo worker horário que já executa
--   as exclusões (MIGRATION_24) — que já sabe montar o zip, subir, assinar e
--   enviar pelo Resend, com confirmação de entrega. O cliente recebe o arquivo
--   por e-mail e acompanha o status na própria tela.
--
-- DECISÕES:
--   • A tabela é a MESMA da MIGRATION_22. O status 'pending' existia desde lá e
--     NUNCA foi usado — a função síncrona gravava 'ready' direto. O estado já
--     estava desenhado para isto; só faltava quem o consumisse.
--   • O prazo de 48h prometido ao cliente é um TETO, não uma espera. Diferente
--     da exclusão, aqui não há nada a proteger com um atraso deliberado: a
--     solicitação é processada na próxima passada do cron (até ~1h). O teto
--     existe para a promessa não quebrar se houver falha e retentativa.
--   • UMA pendente por empresa (índice parcial). Sem isso, cinco toques no botão
--     viram cinco zips — custo de Storage, de egress e cinco e-mails.
--   • Solicitar é permitido MESMO com exclusão agendada (empresa em
--     somente-leitura): é leitura de dado próprio, e é exatamente o caso de quem
--     escolheu "sem exportação" e mudou de ideia. Por isso o INSERT vem de RPC
--     `security definer`, e não de policy — `tenant_has_access` diria não.
--   • `contact_email` é SNAPSHOT do e-mail no momento do pedido: é para lá que o
--     arquivo vai, e o worker não deveria depender de `auth.users` continuar
--     existindo (a conta pode ser excluída no meio do caminho).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) data_exports ganha a trilha de fila e de entrega
-- ---------------------------------------------------------------------
alter table public.data_exports add column if not exists contact_email text;
alter table public.data_exports add column if not exists sent_at timestamptz;
alter table public.data_exports add column if not exists email_id text;
alter table public.data_exports add column if not exists email_status text;
alter table public.data_exports add column if not exists delivered_at timestamptz;
alter table public.data_exports add column if not exists opened_at timestamptz;
alter table public.data_exports add column if not exists delivery_manual boolean not null default false;
alter table public.data_exports add column if not exists updated_at timestamptz not null default now();

-- O CHECK original só admitia pending|ready|failed. A fila acrescenta dois
-- estados de entrega, iguais aos de account_deletion_requests:
--   pending   -> na fila, ainda não processada
--   ready     -> zip montado e no Storage (estado da função SÍNCRONA antiga)
--   sent      -> e-mail entregue ao Resend
--   delivered -> entrega confirmada pelo webhook
--   failed    -> falhou; o dono vê no painel e resolve manualmente
do $$
begin
  alter table public.data_exports drop constraint if exists data_exports_status_check;
  alter table public.data_exports add constraint data_exports_status_check
    check (status in ('pending', 'ready', 'sent', 'delivered', 'failed'));
end $$;

-- Uma pendente por empresa — é o que torna a RPC idempotente.
create unique index if not exists uq_data_export_pending
  on public.data_exports (tenant_id)
  where status = 'pending';

-- Varredura do worker.
create index if not exists idx_data_exports_queue
  on public.data_exports (status, created_at);

-- O webhook do Resend casa o evento pelo id do e-mail.
create index if not exists idx_data_exports_email_id
  on public.data_exports (email_id)
  where email_id is not null;

-- ---------------------------------------------------------------------
-- 2) RPC do cliente: cria a solicitação
-- ---------------------------------------------------------------------
-- SECURITY DEFINER de propósito: a policy `data_exports_owner_access` existe e
-- deixaria o owner inserir direto, mas passar pela RPC dá idempotência (devolve a
-- pendente que já existe em vez de estourar no índice), grava o snapshot do
-- e-mail e mantém o caminho único — inclusive com a empresa em somente-leitura.
create or replace function public.request_data_export()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid;
  v_email   text;
  v_row     public.data_exports;
  v_existia boolean := true;
begin
  select tid into v_tenant from (select public.user_tenant_ids() as tid) s limit 1;
  if v_tenant is null then
    raise exception 'forbidden: usuário sem empresa ativa';
  end if;

  -- Mesma regra da tela: o zip carrega custo de fornecedor e histórico de
  -- cobrança da assinatura, então é owner-only (mais estrito que relatórios).
  if not public.is_tenant_owner(v_tenant) then
    raise exception 'forbidden: apenas o dono (owner) pode exportar os dados da empresa';
  end if;

  -- Já existe uma na fila? Devolve ela — tocar duas vezes não gera dois zips.
  select * into v_row
    from public.data_exports
   where tenant_id = v_tenant and status = 'pending'
   limit 1;

  if not found then
    v_existia := false;
    select u.email into v_email from auth.users u where u.id = auth.uid();

    insert into public.data_exports (tenant_id, client_id, user_id, status, contact_email)
    values (v_tenant, gen_random_uuid(), auth.uid(), 'pending', v_email)
    returning * into v_row;
  end if;

  -- `alreadyQueued` sai do BRANCH, não de comparar timestamps: `now()` no
  -- Postgres é o horário de início da TRANSAÇÃO e não avança dentro dela, então
  -- qualquer heurística de "criada há mais de X" daria falso na mesma transação.
  return jsonb_build_object(
    'id',            v_row.id,
    'status',        v_row.status,
    'contactEmail',  v_row.contact_email,
    'createdAt',     v_row.created_at,
    'alreadyQueued', v_existia
  );
end;
$$;

revoke all on function public.request_data_export() from public, anon;
grant execute on function public.request_data_export() to authenticated;

-- ---------------------------------------------------------------------
-- 3) RPCs do painel do dono
-- ---------------------------------------------------------------------
create or replace function public.admin_list_data_export_requests(
  p_status text default 'pending',
  p_search text default null,
  p_limit  int  default 100,
  p_offset int  default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  return coalesce((
    select jsonb_agg(row_obj order by (row_obj->>'createdAt'))
    from (
      select jsonb_build_object(
        'id',              e.id,
        'tenantId',        e.tenant_id,
        'tenantName',      t.name,
        'tenantPhone',     t.phone,
        'createdAt',       e.created_at,
        'status',          e.status,
        'contactEmail',    e.contact_email,
        'sentAt',          e.sent_at,
        'deliveredAt',     e.delivered_at,
        'openedAt',        e.opened_at,
        'deliveryManual',  e.delivery_manual,
        'completedAt',     e.completed_at,
        'errorMessage',    e.error_message
      ) as row_obj
      from public.data_exports e
      join public.tenants t on t.id = e.tenant_id
     where (p_status is null or p_status = 'all' or e.status = p_status)
       and (
         p_search is null or p_search = '' or
         t.name          ilike '%' || p_search || '%' or
         e.contact_email ilike '%' || p_search || '%'
       )
     order by e.created_at
     limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset)
    ) q
  ), '[]'::jsonb);
end; $$;

create or replace function public.admin_data_export_pending_count()
returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;
  return (select count(*)::int from public.data_exports where status in ('pending', 'sent'));
end; $$;

-- Válvula de escape, igual à das exclusões: o dono mandou o arquivo por fora, ou
-- o webhook do Resend não chegou.
create or replace function public.admin_mark_data_export_delivered(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden: acesso restrito ao dono da aplicação';
  end if;

  update public.data_exports
     set status          = 'delivered',
         sent_at         = coalesce(sent_at, now()),
         delivered_at    = now(),
         delivery_manual = true,
         completed_at    = coalesce(completed_at, now()),
         updated_at      = now()
   where id = p_id
  returning id into v_id;

  if v_id is null then raise exception 'solicitação não encontrada'; end if;
  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.admin_list_data_export_requests(text, text, int, int) to authenticated;
grant execute on function public.admin_data_export_pending_count() to authenticated;
grant execute on function public.admin_mark_data_export_delivered(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4) O gatilho do cron reaproveita o MESMO worker
-- ---------------------------------------------------------------------
-- A MIGRATION_24 só chamava a função quando havia EXCLUSÃO vencida. Agora a
-- chamada também acontece quando há exportação na fila — é o mesmo endpoint,
-- que processa as duas filas na mesma passada.
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

  -- Só bate na Edge Function se houver trabalho em ALGUMA das duas filas.
  if not exists (
    select 1 from public.account_deletion_requests
     where status = 'pending' and scheduled_for <= now()
  ) and not exists (
    select 1 from public.data_exports where status = 'pending'
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
-- 1) Colunas e índices novos existem?
--    select column_name from information_schema.columns
--     where table_name = 'data_exports' order by 1;
--    select indexname from pg_indexes where tablename = 'data_exports';
--
-- 2) O CHECK aceita os estados novos?
--    select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'data_exports_status_check';
--
-- 3) Solicitar como OWNER (pela API, com token real — no SQL Editor auth.uid()
--    é nulo e a RPC recusa):
--    select public.request_data_export();
--    -- chamar duas vezes deve devolver a MESMA id (idempotência).
--
-- TESTE FUNCIONAL:
--   a) solicitar pela tela -> linha 'pending' em data_exports com contact_email;
--   b) rodar `select public.run_due_account_deletions();` -> worker processa,
--      status vira 'sent' e o e-mail chega com texto de EXPORTAÇÃO (nada sobre
--      exclusão de conta);
--   c) webhook do Resend -> status 'delivered';
--   d) solicitar de novo enquanto há 'pending' -> devolve a mesma solicitação,
--      sem gerar um segundo zip.
