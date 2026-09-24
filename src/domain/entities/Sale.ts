// Entidades de domínio de Venda (TS puro). Offline-first (RF-12..16).

// 'split' só aparece em Sale.paymentMethod (venda paga em mais de uma forma) —
// nunca é um método real de um SalePayment individual.
export type PaymentMethod = 'pix' | 'cash' | 'credit_card' | 'debit_card';
export type ConsumptionMode = 'on_site' | 'takeaway';

export interface SalePayment {
  method: PaymentMethod;
  amount: number;
}

export interface SaleItem {
  id: string; // client_id
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface Sale {
  id: string; // client_id (idempotência)
  saleDate: number; // epoch ms
  totalAmount: number;
  // 'split' quando a venda foi paga em mais de uma forma — ver `payments`.
  paymentMethod: PaymentMethod | 'split';
  // Detalhe por forma. Vazio numa venda de ANTES da MIGRATION_28 (nunca teve
  // linha em sale_payments) — quem agrega por forma precisa cair de volta em
  // `paymentMethod`/`totalAmount` nesse caso.
  payments: SalePayment[];
  consumptionMode: ConsumptionMode;
  needsSync: boolean;
  syncedAt?: number;
  items: SaleItem[];
}

// `name` só é usado quando a venda gera um ticket de cozinha (`queue: true`) —
// vira o snapshot de itens do KitchenTicket. Nas demais vendas o campo é
// ignorado (sale_items não guarda nome, igual ao servidor).
export type NewSaleItem = Omit<SaleItem, 'id'> & { name: string };

export interface NewSale {
  payments: SalePayment[];
  consumptionMode: ConsumptionMode;
  items: NewSaleItem[];
  saleDate?: number; // default: agora
  /** Comanda sendo paga (total ou parcialmente). Ver TabRepository.payPartial. */
  tabId?: string;
  /** Nome da comanda em `tabId` — só usado com `queue` (rótulo do ticket). */
  customerName?: string;
  /**
   * Pedido PRÉ-PAGO: gera um ticket de cozinha em vez de fechar a comanda. A
   * comanda NUNCA fecha neste caminho, mesmo pagando tudo que ela tem agora —
   * é assim que o mesmo cliente pede de novo sem o operador recriá-la.
   */
  queue?: boolean;
}
