import type { NewTabItem, Tab } from '../entities/Tab';

/**
 * Repositório de Comandas (tabs) — persistência local (Drizzle/expo-sqlite).
 * Comandas são estado de trabalho local: NÃO sincronizam; ao fechar viram uma Sale.
 */
export interface TabRepository {
  /** Abre uma comanda identificada pelo nome do cliente. */
  open(customerName: string): Promise<Tab>;
  /** Retorna uma comanda (com itens) ou null. */
  get(tabId: string): Promise<Tab | null>;
  /** Lista todas as comandas abertas (mais antiga primeiro), com itens. */
  list(): Promise<Tab[]>;
  /** Adiciona um item à comanda (soma quantidade se já existir). */
  addItem(tabId: string, item: NewTabItem, quantity?: number): Promise<void>;
  /** Reduz 1 unidade; remove a linha ao chegar a zero. */
  decrementItem(tabId: string, productId: string): Promise<void>;
  /** Encerra e apaga a comanda (após o pagamento gerar a Sale). */
  close(tabId: string): Promise<void>;
  /** Observer reativo — retorna função de unsubscribe. */
  observeAll(onChange: (tabs: Tab[]) => void): () => void;
}
