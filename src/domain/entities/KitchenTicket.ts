// Ticket de cozinha (MIGRATION_29). Gerado a cada venda pré-paga ("mandar p/
// churrasqueira") — uma linha por RODADA de pedido, não por comanda: o mesmo
// cliente pedindo várias vezes gera vários tickets independentes, cada um
// rastreável até "Entregue" sem prender a comanda (ver Tab.ts).

export interface KitchenTicketItem {
  name: string;
  quantity: number;
}

export type KitchenTicketStatus = 'pending' | 'ready' | 'delivered';

export interface KitchenTicket {
  id: string; // client_id
  saleId: string;
  tabId?: string;
  customerName: string;
  items: KitchenTicketItem[];
  status: KitchenTicketStatus;
  createdAt: number; // epoch ms — ordena a fila
  needsSync: boolean;
  syncedAt?: number;
}

export interface NewKitchenTicket {
  saleId: string;
  tabId: string;
  customerName: string;
  items: KitchenTicketItem[];
}
