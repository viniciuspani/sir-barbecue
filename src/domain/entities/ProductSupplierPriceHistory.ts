// Histórico de preço de compra por fornecedor (somente leitura — gerado pelo
// servidor via trigger em product_suppliers; o app nunca escreve aqui).
export interface ProductSupplierPriceHistory {
  id: string;
  productId: string;
  supplierId: string;
  purchasePrice: number;
  isPreferred: boolean;
  recordedAt: number; // epoch ms
  syncedAt?: number;
}
