-- =====================================================================
-- MIGRATION 27 — Pedido pré-pago: a comanda paga vira fila da churrasqueira
-- Aplica SOBRE MIGRATION_09_tabs + MIGRATION_24 (create_sale vigente).
-- Idempotente.
--
-- MOTIVAÇÃO:
--   No pico de movimento a atendente inverte o fluxo do balcão: cobra ANTES de
--   o pedido ser produzido ("3 churrasquinhos", paga, e só então vai para a
--   grelha), para não perder o pagamento enquanto a fila cresce. Hoje o
--   pagamento fecha a comanda: ela sai de `status='open'`, o app apaga a linha
--   local e o pedido DESAPARECE da tela. O churrasqueiro fica sem saber o que
--   assar, de quem é e o que já entregou — justamente no momento de mais
--   pressão. A comanda precisa continuar viva depois de paga.
--
-- DECISÕES:
--   • Dois status novos em vez de uma tabela de pedidos: a comanda já É o
--     pedido (nome do cliente + itens), já sincroniza e já tem realtime. Criar
--     uma entidade paralela duplicaria os itens e o isolamento por empresa.
--       'paid'  = pago, na grelha.
--       'ready' = saiu da grelha, aguardando o cliente retirar.
--     'ready' é OPCIONAL: o app oferece "Entregue" direto de 'paid', porque no
--     pico um toque a menos vale mais do que a precisão do rastro.
--   • 'cancelled' separa comanda DESCARTADA de comanda paga e entregue, que
--     hoje compartilham o 'closed' — o que impede distinguir, no relatório, um
--     pedido que nunca existiu de um que foi vendido.
--   • `paid_at` é coluna própria e não reaproveita `closed_at`: a fila se ordena
--     por ela (o que importa para quem assa é há quanto tempo o cliente pagou)
--     e `closed_at` continua significando "encerrada".
--   • create_sale ganha `p_queue`: o PWA precisa deixar a comanda em 'paid' na
--     MESMA transação da venda. O app mobile NÃO usa esta RPC (é offline-first,
--     faz upsert direto no sync) — para ele valem só as colunas e o CHECK.
-- =====================================================================

-- 1) Status novos ------------------------------------------------------
-- O CHECK de MIGRATION_09 aceita só ('open','closed'). Sem soltá-lo, o upsert
-- do sync com status='paid' é recusado e o pedido pago nunca chega ao aparelho
-- da churrasqueira.
alter table public.tabs drop constraint if exists tabs_status_check;
alter table public.tabs add constraint tabs_status_check
  check (status in ('open', 'paid', 'ready', 'closed', 'cancelled'));

-- 2) Marcos do pedido pré-pago ----------------------------------------
alter table public.tabs add column if not exists paid_at  timestamptz;
alter table public.tabs add column if not exists ready_at timestamptz;
-- `sale_client_id` já existe (MIGRATION_09) e passa a ser preenchido também
-- pelo mobile: é o que amarra o pedido na grelha à venda que o cobrou.

comment on column public.tabs.paid_at is
  'Pedido pré-pago: quando o cliente pagou. Ordena a fila da churrasqueira.';
comment on column public.tabs.ready_at is
  'Quando o churrasqueiro marcou o pedido como pronto para retirada.';

-- 3) Índices -----------------------------------------------------------
-- idx_tabs_tenant_status (tenant_id, status, opened_at) já serve à consulta do
-- sync ("comandas vivas desta empresa"), que filtra por tenant + status.

-- 4) RLS ---------------------------------------------------------------
-- Nada a mudar: tabs_select/tabs_write (MIGRATION_11) já liberam TODO membro
-- com assinatura ativa, e o churrasqueiro é um 'employee'. Marcar pronto e
-- entregue é UPDATE na mesma linha que ele já podia ler e escrever.

-- 5) create_sale com fila ---------------------------------------------
-- Cópia fiel da versão vigente (MIGRATION_24) com UM parâmetro novo no fim.
-- Acrescentar parâmetro com DEFAULT cria SOBRECARGA: a assinatura de 6
-- argumentos passaria a coexistir com a de 7 e a chamada ficaria ambígua
-- ("function is not unique"). Por isso o DROP da anterior — mesmo motivo
-- documentado na MIGRATION_09 §5.
drop function if exists public.create_sale(uuid, uuid, text, text, jsonb, uuid);

create or replace function public.create_sale(
  p_tenant_id        uuid,
  p_client_id        uuid,
  p_payment_method   text,
  p_consumption_mode text,
  p_items            jsonb,
  p_tab_client_id    uuid default null,
  -- true = pedido pré-pago: a comanda vai para a fila ('paid') em vez de encerrar.
  p_queue            boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total numeric(12,2);
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'venda sem itens';
  end if;

  -- Idempotência antes das guardas: retry de venda já gravada não pode falhar.
  if exists (select 1 from public.sales where client_id = p_client_id) then
    return p_client_id;
  end if;

  -- Guarda (MIGRATION_24): exclusão agendada não é problema de cobrança.
  if exists (select 1 from public.account_deletion_requests r
              where r.tenant_id = p_tenant_id and r.status = 'pending') then
    raise exception 'exclusão de conta agendada: cancele a solicitação para voltar a vender';
  end if;

  -- Guarda de assinatura (A06-01). A RLS já barraria; isto é pela mensagem.
  if not public.tenant_has_access(p_tenant_id) then
    raise exception 'assinatura inativa: regularize para continuar vendendo';
  end if;

  -- Guarda de preço (A06-02).
  if p_tab_client_id is null then
    if exists (
      select 1
        from jsonb_array_elements(p_items) as i
       where not exists (
         select 1
           from public.products pr
          where pr.client_id = (i->>'product_client_id')::uuid
            and pr.tenant_id = p_tenant_id
            and abs((i->>'unit_price')::numeric - pr.price) <= 0.01
       )
    ) then
      raise exception 'preço divergente do cadastro do produto';
    end if;
  else
    if exists (
      select 1
        from jsonb_array_elements(p_items) as i
       where not exists (
         select 1
           from public.tab_items ti
          where ti.tab_client_id = p_tab_client_id
            and ti.product_client_id = (i->>'product_client_id')::uuid
            and abs((i->>'unit_price')::numeric - ti.unit_price) <= 0.01
       )
    ) then
      raise exception 'preço divergente da comanda';
    end if;
  end if;

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_price')::numeric), 0)
    into v_total
    from jsonb_array_elements(p_items) as i;

  insert into public.sales (
    tenant_id, client_id, total_amount, payment_method, consumption_mode, sale_date, synced_at
  )
  values (
    p_tenant_id, p_client_id, v_total, p_payment_method, p_consumption_mode, now(), now()
  );

  insert into public.sale_items (client_id, sale_client_id, product_client_id, quantity, unit_price)
  select
    gen_random_uuid(),
    p_client_id,
    (i->>'product_client_id')::uuid,
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric
  from jsonb_array_elements(p_items) as i;

  if p_tab_client_id is not null then
    -- Pré-pago: a comanda NÃO encerra, vai para a fila. O estoque já foi
    -- baixado pelos sale_items acima, então ela deixa de reservar — é por isso
    -- que 'paid' sai da lista de comandas abertas e não volta a ser destino de
    -- lançamento (o pedido já foi cobrado).
    if p_queue then
      update public.tabs
         set status = 'paid', paid_at = now(), sale_client_id = p_client_id, updated_at = now()
       where client_id = p_tab_client_id
         and tenant_id = p_tenant_id
         and status = 'open';
    else
      update public.tabs
         set status = 'closed', closed_at = now(), sale_client_id = p_client_id, updated_at = now()
       where client_id = p_tab_client_id
         and tenant_id = p_tenant_id
         and status = 'open';
    end if;
    -- 0 linhas = comanda inexistente, de outra empresa ou já cobrada por outro
    -- aparelho. Abortar evita cobrar duas vezes a mesma comanda.
    if not found then
      raise exception 'comanda não está aberta (já foi fechada em outro aparelho?)';
    end if;
  end if;

  return p_client_id;
end;
$$;

comment on function public.create_sale(uuid, uuid, text, text, jsonb, uuid, boolean) is
  'Registra venda + itens + baixa de estoque em UMA transação. Com p_tab_client_id encerra a comanda, ou a manda para a fila da churrasqueira quando p_queue. Idempotente por client_id; total calculado no servidor.';

revoke all on function public.create_sale(uuid, uuid, text, text, jsonb, uuid, boolean) from public;
grant execute on function public.create_sale(uuid, uuid, text, text, jsonb, uuid, boolean) to authenticated;
