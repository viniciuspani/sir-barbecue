import type { NewTabItem, Tab } from '../entities/Tab';

/**
 * Repositório de Comandas (tabs) — persistência local (Drizzle/expo-sqlite),
 * sincronizada com o servidor pelo syncEngine.
 *
 * Duas listas de propósito diferente, e a separação é deliberada:
 *  - `list`/`observeAll` → comandas ABERTAS. É a lista que alimenta o cálculo de
 *    reserva de estoque (src/lib/saleStock.ts). Comanda paga NÃO pode entrar aqui:
 *    a venda já baixou o estoque, e contá-la de novo subtrairia o produto duas vezes.
 *  - `listQueue`/`observeQueue` → comandas PAGAS aguardando produção/entrega.
 */
export interface TabRepository {
  /** Abre uma comanda identificada pelo nome do cliente. */
  open(customerName: string): Promise<Tab>;
  /** Retorna uma comanda (com itens) ou null. */
  get(tabId: string): Promise<Tab | null>;
  /** Comandas ABERTAS (mais antiga primeiro), com itens. */
  list(): Promise<Tab[]>;
  /** Fila da churrasqueira: comandas pagas ('paid'/'ready'), pagamento mais antigo primeiro. */
  listQueue(): Promise<Tab[]>;
  /** Adiciona um item à comanda (soma quantidade se já existir). */
  addItem(tabId: string, item: NewTabItem, quantity?: number): Promise<void>;
  /** Reduz 1 unidade; remove a linha ao chegar a zero. */
  decrementItem(tabId: string, productId: string): Promise<void>;
  /** Pago e enviado para a churrasqueira: entra na fila em vez de encerrar. */
  markPaid(tabId: string, saleId: string): Promise<void>;
  /** Churrasqueiro sinaliza que o pedido saiu da grelha. */
  markReady(tabId: string): Promise<void>;
  /** Pedido entregue ao cliente — encerra a comanda. `saleId` só no pagamento na hora. */
  markDelivered(tabId: string, saleId?: string): Promise<void>;
  /** Comanda descartada sem pagamento (não é venda). */
  cancel(tabId: string): Promise<void>;
  /** Observer reativo das comandas abertas — retorna função de unsubscribe. */
  observeAll(onChange: (tabs: Tab[]) => void): () => void;
  /** Observer reativo da fila da churrasqueira — retorna função de unsubscribe. */
  observeQueue(onChange: (tabs: Tab[]) => void): () => void;
}
