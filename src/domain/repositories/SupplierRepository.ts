import type { NewProductSupplier, ProductSupplier } from '../entities/ProductSupplier';
import type { ProductSupplierPriceHistory } from '../entities/ProductSupplierPriceHistory';
import type { Supplier } from '../entities/Supplier';

/** Interface de repositório de Fornecedores + associações a produtos (RF-07). */
export interface SupplierRepository {
  list(): Promise<Supplier[]>;
  getById(id: string): Promise<Supplier | null>;
  create(input: Omit<Supplier, 'id' | 'needsSync' | 'syncedAt'>): Promise<Supplier>;
  update(id: string, patch: Partial<Supplier>): Promise<void>;
  observeAll(onChange: (suppliers: Supplier[]) => void): () => void;
  /** Produtos associados a um fornecedor (só vínculos ATIVOS). */
  listLinks(supplierId: string): Promise<ProductSupplier[]>;
  /** Fornecedores associados a um produto (só vínculos ATIVOS) — visão inversa de listLinks. */
  listLinksByProduct(productId: string): Promise<ProductSupplier[]>;
  /** Cria o vínculo; se já existir (mesmo inativo), reativa e atualiza o preço (mantém histórico). */
  addLink(input: NewProductSupplier): Promise<void>;
  /** Edita o preço de compra (e/ou preferido) de um vínculo já existente. */
  updateLink(id: string, patch: { purchasePrice?: number; isPreferred?: boolean }): Promise<void>;
  /** Inativa o vínculo (troca de fornecedor): some das telas de uso e do custo, fica no histórico. */
  inactivateLink(id: string): Promise<void>;
  /** Exclusão definitiva (corrige cadastro errado): marca p/ apagar no servidor via sync. */
  deleteLink(id: string): Promise<void>;
  /** Histórico de preço de compra de um produto, mais recente primeiro. Somente leitura. */
  listPriceHistory(productId: string, limit: number): Promise<ProductSupplierPriceHistory[]>;
}
