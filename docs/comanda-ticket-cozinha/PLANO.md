# Comanda nunca fecha sozinha por pagamento — "ticket de cozinha" separado da comanda

## Context

Cenário real reportado: comanda "Zé da Rua" foi paga e mandada pra churrasqueira (pré-pago). Ela some da lista "Em aberto" porque `tabs.status` vira `'paid'`. Se o Zé pedir de novo, hoje não tem como — o operador precisa criar uma comanda nova do zero, digitando o nome de novo, e faria isso a cada uma das 5 rodadas que ele pedir.

Confirmado com o usuário (e ele mesmo conectou os dois casos): isso é o MESMO problema de raiz do pagamento parcial que já construí antes. Hoje "pagar" (total ou parcial) está amarrado a "a comanda sair da lista de abertas", porque a fila da churrasqueira (`tabs.status IN ('paid','ready')`) lê ao vivo os `tab_items` da comanda — ela não tem uma cópia própria do que foi mandado pra cozinha. Enquanto isso não mudar, a comanda não pode ficar "aberta pra sempre" (disponível pra novos pedidos) e "na fila da cozinha" (visível pro churrasqueiro) ao mesmo tempo, porque são o mesmo status.

**Decisão**: desacoplar o "ticket de cozinha" da comanda. Cada vez que um pedido é mandado pra churrasqueira (pré-pago), isso vira um registro PRÓPRIO (`kitchen_tickets`, ligado à venda via `sales.tab_client_id`, já existente desde o pagamento dividido) — não mais um status da comanda. A comanda (`tabs`) passa a só ter `open`/`closed`/`cancelled`; ela nunca fecha sozinha por causa de um pagamento, só quando o operador fecha explicitamente. Isso resolve os dois cenários com a mesma mudança:
- **Pagamento parcial** (já funciona): paga uma parte, o resto fica na comanda aberta.
- **Pedido repetido do Zé** (esta tarefa): paga tudo que tem agora, manda pra churrasqueira, a comanda continua aberta pra próxima rodada.

## Por que uma tabela nova (`kitchen_tickets`) em vez de mexer em `sales`

Investigação encontrou que o sync do mobile assume `sales` **imutável** depois de gravada (`syncEngine.ts` — pull de vendas não tenta atualizar nada, só insere). O status de cozinha (`pending → ready → delivered`) precisa mudar depois de criado e precisa propagar entre aparelhos (o celular do churrasqueiro marca "Pronto", o caixa precisa ver). Colocar isso direto em `sales` quebraria essa suposição. Uma tabela nova, mutável, com seu próprio sync/realtime (espelhando exatamente o padrão que `tabs`/`tab_items` já usam) evita mexer no que já funciona.

**Denormalização deliberada**: `kitchen_tickets` guarda `customer_name` e `items` (snapshot `[{name, quantity}]`) direto na linha — mesmo padrão que `tab_items` já usa pra não precisar de join (`name`/`unit_price` denormalizados). Isso evita ter que ligar as telas de fila a uma lista de produtos que elas hoje não carregam.

## Backend (Supabase) — nova migração `MIGRATION_29_kitchen_tickets.sql`

1. **Tabela `kitchen_tickets`**: `id`, `client_id` unique, `tenant_id`, `sale_client_id` unique (`references sales(client_id) on delete cascade`), `tab_client_id` (`references tabs(client_id) on delete set null`), `customer_name varchar(120)`, `items jsonb` (`[{name, quantity}]`), `status varchar(20) check in ('pending','ready','delivered')` default `'pending'`, `created_at`, `ready_at`, `delivered_at`, `updated_at`. RLS `tenant_all` direto por `tenant_id` (mesmo padrão de `tabs`/`sales`). Adicionar à publicação `supabase_realtime`.

2. **`create_sale` reescrita** (mesma assinatura — `create or replace`, sem troca de parâmetros):
   - `p_items` ganha o campo `name` em cada elemento (cliente já tem esse valor em mãos — `CartItem.name`/`lines[].name`). Só é lido quando cria o ticket.
   - Bloco do `tab_items` **sempre** decrementa o que foi pago (delete-então-update, já corrigido nesta sessão) — não tem mais ramo "pagamento total não mexe" (isso só existia pra não quebrar a fila antiga baseada em status; a fila nova não lê mais `tab_items`).
   - Depois de decrementar: se `p_queue` → insere 1 linha em `kitchen_tickets` (status `'pending'`, `items` montado de `p_items`, `customer_name` de `tabs.customer_name`) e SÓ toca `tabs.updated_at` — nunca fecha a comanda no fluxo pré-pago, seja pagamento total ou parcial do que está na comanda agora.
   - Se **não** `p_queue`: recalcula se o pagamento cobriu a comanda inteira (mesmo check de antes, só que agora usado exclusivamente pra decidir se fecha) — total → `tabs.status='closed'` (comportamento de sempre do botão "Receber e encerrar"); parcial → comanda continua `open` (comportamento de sempre do pagamento parcial).
   - Lock `FOR UPDATE` na comanda continua igual (mesma razão de concorrência).

3. **Migração de dados** (mesma migração, bloco único): toda `tabs` que hoje está em `'paid'/'ready'` vira `kitchen_tickets` (status `'ready'` se estava `'ready'`, senão `'pending'`, itens copiados de `tab_items`), os `tab_items` dela são apagados (já foram pagos) e ela volta pra `status='open'`. Cobre as 3 comandas de teste já travadas em produção.

## Web (`c:\develop\WEB\sir-barbecue-web`)

- `src/core/domain/entities/Tab.ts` — `TabStatus` vira só `'open'|'closed'|'cancelled'`; remove `QUEUE_STATUSES`.
- Novo `src/core/domain/entities/KitchenTicket.ts` — tipo `KitchenTicket { id, saleId, tabId, customerName, items: {name, quantity}[], status: 'pending'|'ready'|'delivered', createdAt }`.
- `src/data/repositories/tabs.ts` — remove `markTabReady`/`markTabDelivered`/o filtro `QUEUE_STATUSES`; `discardTab` continua igual. Novo `closeTab(tenantId, tabId)`: `update tabs set status='closed', closed_at=now() where client_id=... and status='open'` (chamado só quando `tab.items.length === 0`, checado antes no client).
- Novo `src/data/repositories/kitchenTickets.ts` — `listKitchenTickets(tenantId)` (status `pending`/`ready`, ordenado por `created_at`), `markTicketReady(id)`, `markTicketDelivered(id)`.
- `src/data/queries/tabs.ts` — troca `useMarkTabReady`/`useMarkTabDelivered` por `useKitchenTickets`/`useMarkTicketReady`/`useMarkTicketDelivered`; `useTabsRealtime` ganha um segundo canal (`postgres_changes` em `kitchen_tickets`) invalidando `['kitchenTickets', tenantId]`.
- `src/data/repositories/sales.ts` — `NewSaleInput.items` ganha `name` (já disponível no `CartItem` que `FecharVenda.tsx` já tem); `createSale()` inclui `name` no payload de `p_items`.
- `src/screens/venda/Comandas.tsx` — seção "Na churrasqueira" passa a mapear `KitchenTicket[]` (de `useKitchenTickets`) em vez de `Tab[]`; card mostra `customerName`, `items` (direto do snapshot, sem join), botões "Pronto"/"Entregue" chamando os novos hooks. Seção "Em aberto" ganha um botão "Encerrar comanda" (ao lado de "Lançar itens"), habilitado só quando `tab.items.length === 0`, chamando `closeTab`.
- `src/screens/venda/FecharVenda.tsx` — inclui `name: i.name` nos items enviados a `createSale`; nenhuma outra mudança (a tela já trata full/parcial corretamente pro caso não-fila; o caso fila já esconde o botão quando parcial, e agora ele também funciona certo no caso "pagou tudo e mandou pra fila").

## Mobile (`c:\develop\MOBILE\sir-barbecue`)

- `src/domain/entities/Tab.ts` — mesma simplificação de `TabStatus`; remove `QUEUE_STATUSES` (mantém `LIVE_STATUSES` só como `['open']` ou remove se não fizer mais sentido pro sync).
- Novo `src/domain/entities/KitchenTicket.ts` — mesmo shape do web.
- `src/data/local/schema.ts` + `database.ts` — nova tabela local `kitchen_tickets` (mesmas colunas, `items` como `text` JSON serializado, `+needsSync/syncedAt`), criada via `CREATE TABLE IF NOT EXISTS` no bootstrap (tabela nova, sem precisar de ALTER incremental).
- `src/domain/entities/Sale.ts` — `NewSaleItem` ganha `name`; `NewSale` ganha `queue?: boolean` (pra `SaleRepository.create` saber se deve gerar o ticket).
- `src/data/repositories/SaleRepository.ts` — `create()`: quando `input.queue && input.tabId`, insere 1 linha em `kitchen_tickets` (status `'pending'`) na MESMA transação, com `items` = `JSON.stringify(input.items.map(i => ({name: i.name, quantity: i.quantity})))` e `customerName` vindo de `input.customerName` (novo campo em `NewSale`, populado por `fechar.tsx` a partir de `params.customerName`).
- `src/data/repositories/TabRepository.ts` — `payPartial` sempre decrementa/apaga (remove o branch "pagamento total não mexe", mesma simplificação do servidor); remove `markPaid`/`markReady`/`markDelivered`/`listQueue`/`observeQueue`; adiciona `close(tabId)` (reaproveita o `finish()` privado já existente, sem `saleId`).
- Novo `src/data/repositories/KitchenTicketRepository.ts` — `list()`/`observeQueue()` (lê local), `markReady(id)`, `markDelivered(id)` (marca `needsSync=true` local).
- `src/data/sync/syncEngine.ts` — novo par `pushKitchenTickets`/`pullKitchenTickets` (mesmo padrão de `pushTabs`/upsert por `client_id`); `pushSalesWithItems` já cobre o insert inicial do ticket (fica dentro da mesma transação local de `SaleRepository.create`, só precisa ser empurrado depois).
- `src/data/sync/tabsLive.ts` (ou um novo `kitchenTicketsLive.ts` ao lado) — mesmo canal `postgres_changes`, agora também assinando `kitchen_tickets`, disparando `syncKitchenTicketsNow()`.
- `app/(app)/venda/fechar.tsx` — `onConfirm`: remove as chamadas a `markPaid`/`markDelivered` depois de `payPartial`; passa `queue` e `customerName` (de `params.customerName`) pro `saleRepository.create(...)`. O botão "Receber e mandar p/ churrasqueira" deixa de depender de `exhausted` pra decidir nada (a comanda nunca fecha nesse caminho); o botão "Receber e encerrar" continua usando `exhausted` (só ele fecha, e só quando é pagamento total).
- `app/(app)/comandas/index.tsx` — mesma reestruturação do web: seção "Na churrasqueira" lê `kitchenTicketRepository.observeQueue()`; seção "Em aberto" ganha o botão "Encerrar comanda" (`tabRepository.close(tab.id)`, habilitado só com `tab.items.length === 0`).

## O que NÃO muda

- Reserva de estoque (`committedQuantities`/`reservedByTabs`) continua lendo só `tabs` `status='open'` + seus `tab_items` — sem mudança, já que `tab_items` sempre reflete "não pago ainda".
- Baixa de estoque na venda (`deduct_stock_on_sale`) continua disparando por `sale_items`, sem relação com `kitchen_tickets`.
- Split de pagamento (`sale_payments`) — inalterado, ortogonal a esta mudança.

## Verificação

- Web: `npx tsc --noEmit && npx vitest run`.
- Mobile: `npx tsc --noEmit`.
- `MIGRATION_29_kitchen_tickets.sql`: escrita, não executada por mim — usuário aplica no SQL Editor (mesmo padrão já estabelecido). Ela é quem também destrava as 3 comandas de teste já travadas em produção.
- Sem como testar de ponta a ponta aqui (precisa de dois aparelhos/sessões reais); vou sinalizar ao usuário os pontos mais sensíveis pra ele testar manualmente: (1) pré-pago com pagamento total mantendo a comanda aberta, depois lançar um 2º pedido nela; (2) "Pronto"/"Entregue" propagando em tempo real entre dois navegadores/aparelhos; (3) "Encerrar comanda" bloqueado quando ainda tem item não pago.

## Arquivos críticos

- `docs/banco-multi-cliente/MIGRATION_29_kitchen_tickets.sql` (novo)
- `app/(app)/venda/fechar.tsx`, `app/(app)/comandas/index.tsx` (mobile)
- `src/data/repositories/TabRepository.ts`, `src/data/repositories/KitchenTicketRepository.ts` (novo), `src/data/sync/syncEngine.ts` (mobile)
- `src/screens/venda/FecharVenda.tsx`, `src/screens/venda/Comandas.tsx` (web)
- `src/data/repositories/tabs.ts`, `src/data/repositories/kitchenTickets.ts` (novo), `src/data/queries/tabs.ts` (web)
