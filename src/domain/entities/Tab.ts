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
 * Ciclo de vida da comanda (MIGRATION_29): ela NUNCA fecha sozinha por causa
 * de um pagamento — só quando o operador fecha de propósito ("Receber e
 * encerrar" com pagamento total, ou "Encerrar comanda" numa comanda já sem
 * itens pendentes). Um pedido pré-pago ("mandar p/ churrasqueira") gera um
 * KitchenTicket (ver KitchenTicket.ts) em vez de mudar o status da comanda —
 * assim o mesmo cliente pode pedir de novo na mesma comanda sem o operador
 * recriá-la a cada rodada.
 *
 *   open ─(pagamento total, sem fila: "Receber e encerrar")──► closed
 *   open ─(fecha vazia: "Encerrar comanda")───────────────────► closed
 *   open ─(descartar)──────────────────────────────────────────► cancelled
 *
 * (pagamento parcial, com ou sem fila, e pagamento total COM fila: a comanda
 * continua `open`.)
 */
export type TabStatus = 'open' | 'closed' | 'cancelled';

/** Status que continuam existindo no aparelho (os demais o sync apaga). */
export const LIVE_STATUSES = ['open'] as const satisfies readonly TabStatus[];

export interface Tab {
  id: string;
  customerName: string; // rótulo da comanda; não é cadastro de cliente (venda anônima — Q9)
  openedAt: number; // epoch ms
  status: TabStatus;
  items: TabItem[];
}

export interface NewTabItem {
  productId: string;
  name: string;
  unitPrice: number;
}
