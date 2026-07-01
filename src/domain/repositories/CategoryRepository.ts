import type { Category } from '../entities/Category';

/**
 * Interface de repositório no domínio (Repository Pattern).
 * Presentation e Use Cases dependem APENAS desta interface.
 */
export interface CategoryRepository {
  list(): Promise<Category[]>;
  create(name: string): Promise<Category>;
  /** Observer reativo — retorna função de unsubscribe. */
  observeAll(onChange: (categories: Category[]) => void): () => void;
}
