// Entidades de domínio de Comanda (tab). SINCRONIZADA entre aparelhos (plano web, F5).
// Uma comanda é um "carrinho nomeado e persistente": vira Sale no pagamento (RF-12..14).

export interface TabItem {
  id: string;
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

/**
 * Ciclo de vida da comanda. Dois caminhos saem de `open`, conforme o pedido é
 * pago DEPOIS ou ANTES de ser produzido:
 *
 *                  ┌─ "Receber e encerrar" ──────────────────────► closed
 *   open ─(paga)───┤
 *     │            └─ "Mandar p/ churrasqueira" ─► paid ─► ready ─► closed
 *     │                                              └──"Entregue"──┘
 *     └─ descartar ───────────────────────────────────────────────► cancelled
 *
 * `paid`/`ready` existem porque no pico de movimento a atendente cobra primeiro
 * para não perder o pagamento, e o pedido só então vai para a grelha: sem esses
 * estados a comanda morreria no pagamento e o churrasqueiro ficaria sem saber o
 * que assar. `cancelled` separa comanda descartada de comanda paga e entregue,
 * que antes compartilhavam o `closed`.
 */
export type TabStatus = 'open' | 'paid' | 'ready' | 'closed' | 'cancelled';

/** Comandas que ocupam a churrasqueira: pagas, ainda não entregues. */
export const QUEUE_STATUSES = ['paid', 'ready'] as const satisfies readonly TabStatus[];

/** Status que continuam existindo no aparelho (os demais o sync apaga). */
export const LIVE_STATUSES = ['open', ...QUEUE_STATUSES] as const satisfies readonly TabStatus[];

export interface Tab {
  id: string;
  customerName: string; // rótulo da comanda; não é cadastro de cliente (venda anônima — Q9)
  openedAt: number; // epoch ms
  status: TabStatus;
  /** Quando o cliente pagou. Presente a partir de `paid`; ordena a fila. */
  paidAt?: number;
  readyAt?: number;
  /** Venda que cobrou esta comanda (só no fluxo pré-pago). */
  saleId?: string;
  items: TabItem[];
}

export interface NewTabItem {
  productId: string;
  name: string;
  unitPrice: number;
}
