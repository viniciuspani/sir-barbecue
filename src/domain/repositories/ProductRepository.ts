import type { Product } from '../entities/Product';

/**
 * Interface de repositório no domínio (Repository Pattern).
 * Isola a fonte de dados local: hoje WatermelonDB; no Plano B, expo-sqlite + Drizzle.
 * Presentation e Use Cases dependem APENAS desta interface.
 */
export interface ProductRepository {
  list(): Promise<Product[]>;
  getById(id: string): Promise<Product | null>;
  create(input: Omit<Product, 'id' | 'needsSync' | 'syncedAt'>): Promise<Product>;
  update(id: string, patch: Partial<Product>): Promise<void>;
  /** Observer reativo — retorna função de unsubscribe. */
  observeAll(onChange: (products: Product[]) => void): () => void;
}
