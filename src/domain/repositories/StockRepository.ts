import type { NewStockEntry, StockEntry } from '../entities/StockEntry';
import type { StockItem } from '../entities/StockItem';

/**
 * Interface de repositório de Estoque (Repository Pattern).
 * Saldo local calculado offline; o sync de estoque é um follow-up (servidor recalcula via triggers).
 */
export interface StockRepository {
  getItem(productId: string): Promise<StockItem | null>;
  /** Registra entrada (histórico) e incrementa o saldo, em transação (RF-09). */
  registerEntry(input: NewStockEntry): Promise<void>;
  /** Configura o limite de alerta de estoque baixo (RF-11). */
  setAlertThreshold(productId: string, threshold: number): Promise<void>;
  listEntries(productId: string): Promise<StockEntry[]>;
  /** RF-10: baixa de estoque ao concluir a venda (apenas produtos com saldo controlado). */
  deductForSale(items: { productId: string; quantity: number }[]): Promise<void>;
  observeItems(onChange: (items: StockItem[]) => void): () => void;
}
