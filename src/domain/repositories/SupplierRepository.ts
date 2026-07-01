import type { NewProductSupplier, ProductSupplier } from '../entities/ProductSupplier';
import type { Supplier } from '../entities/Supplier';

/** Interface de repositório de Fornecedores + associações a produtos (RF-07). */
export interface SupplierRepository {
  list(): Promise<Supplier[]>;
  getById(id: string): Promise<Supplier | null>;
  create(input: Omit<Supplier, 'id' | 'needsSync' | 'syncedAt'>): Promise<Supplier>;
  update(id: string, patch: Partial<Supplier>): Promise<void>;
  observeAll(onChange: (suppliers: Supplier[]) => void): () => void;
  /** Produtos associados a um fornecedor (com preço de compra). */
  listLinks(supplierId: string): Promise<ProductSupplier[]>;
  addLink(input: NewProductSupplier): Promise<void>;
  removeLink(id: string): Promise<void>;
}
