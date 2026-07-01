import type { NewSale, Sale } from '../entities/Sale';

/**
 * Interface de repositório de Vendas (Repository Pattern).
 * Implementação local sobre Drizzle/expo-sqlite — Presentation/Use Cases dependem só desta interface.
 */
export interface SaleRepository {
  /** Registra a venda + itens localmente (offline-first, em transação) e marca needs_sync. */
  create(input: NewSale): Promise<Sale>;
  list(): Promise<Sale[]>;
  /** Observer reativo — retorna função de unsubscribe. */
  observeAll(onChange: (sales: Sale[]) => void): () => void;
}
