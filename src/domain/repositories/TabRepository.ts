import type { NewTabItem, Tab } from '../entities/Tab';

/**
 * Repositório de Comandas (tabs) — persistência local (Drizzle/expo-sqlite),
 * sincronizada com o servidor pelo syncEngine.
 *
 * A fila da churrasqueira NÃO vive aqui desde a MIGRATION_29 — ver
 * `KitchenTicketRepository`. Uma comanda só sai de `list`/`observeAll` quando
 * o operador a fecha de propósito (`close`/`cancel`); pagar (total ou
 * parcial, com ou sem fila) nunca fecha sozinha.
 */
export interface TabRepository {
  /** Abre uma comanda identificada pelo nome do cliente. */
  open(customerName: string): Promise<Tab>;
  /** Retorna uma comanda (com itens) ou null. */
  get(tabId: string): Promise<Tab | null>;
  /**
   * Comandas ABERTAS (mais antiga primeiro), com itens. Alimenta a reserva de
   * estoque (src/lib/saleStock.ts) pelos itens AINDA NÃO pagos.
   */
  list(): Promise<Tab[]>;
  /** Adiciona um item à comanda (soma quantidade se já existir). */
  addItem(tabId: string, item: NewTabItem, quantity?: number): Promise<void>;
  /** Reduz 1 unidade; remove a linha ao chegar a zero. */
  decrementItem(tabId: string, productId: string): Promise<void>;
  /**
   * Baixa da comanda o que acabou de ser pago (pagamento total ou parcial —
   * quantidade paga de cada item nunca excede o que a linha tem). Não mexe em
   * `status`: quem decide fechar é o chamador, com base no retorno.
   * @returns true se a comanda ficou sem itens pendentes (pagamento total).
   */
  payPartial(tabId: string, paidItems: { productId: string; quantity: number }[]): Promise<boolean>;
  /** Comanda descartada sem pagamento (não é venda). */
  cancel(tabId: string): Promise<void>;
  /** Encerra a comanda de propósito (sem itens pendentes, ou pagamento total sem fila). */
  close(tabId: string): Promise<void>;
  /** Observer reativo das comandas abertas — retorna função de unsubscribe. */
  observeAll(onChange: (tabs: Tab[]) => void): () => void;
}
