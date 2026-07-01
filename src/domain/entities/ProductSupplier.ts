// Associação produto↔fornecedor com preço de compra (RF-07).
export interface ProductSupplier {
  id: string;
  productId: string;
  supplierId: string;
  purchasePrice: number;
  isPreferred: boolean;
  needsSync: boolean;
  syncedAt?: number;
}

export interface NewProductSupplier {
  productId: string;
  supplierId: string;
  purchasePrice: number;
  isPreferred?: boolean;
}
