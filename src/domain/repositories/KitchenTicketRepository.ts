import type { KitchenTicket } from '../entities/KitchenTicket';

/**
 * Repositório de tickets de cozinha (MIGRATION_29) — persistência local
 * (Drizzle/expo-sqlite), sincronizada com o servidor pelo syncEngine.
 *
 * Cada ticket nasce dentro de `SaleRepository.create` (venda pré-paga, ver
 * `NewSale.queue`) — este repositório só cobre as transições DEPOIS de criado
 * (pronto, entregue), que não mexem em dinheiro nem em estoque.
 */
export interface KitchenTicketRepository {
  /** Fila da churrasqueira: tickets pendentes/prontos, mais antigo primeiro. */
  list(): Promise<KitchenTicket[]>;
  /** Churrasqueiro sinaliza que o pedido saiu da grelha. */
  markReady(ticketId: string): Promise<void>;
  /** Pedido entregue ao cliente: sai da fila ativa. */
  markDelivered(ticketId: string): Promise<void>;
  /** Observer reativo da fila — retorna função de unsubscribe. */
  observeQueue(onChange: (tickets: KitchenTicket[]) => void): () => void;
}
