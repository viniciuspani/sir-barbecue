// Associação produto↔fornecedor com preço de compra (RF-07).
export interface ProductSupplier {
  id: string;
  productId: string;
  supplierId: string;
  purchasePrice: number;
  isPreferred: boolean;
  /** Vínculo ativo. Inativo (troca de fornecedor) sai do custo, fica no histórico. */
  isActive: boolean;
  needsSync: boolean;
  syncedAt?: number;
}

export interface NewProductSupplier {
  productId: string;
  supplierId: string;
  purchasePrice: number;
  isPreferred?: boolean;
}
