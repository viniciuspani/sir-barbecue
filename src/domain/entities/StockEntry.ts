// Entidade de domínio (TS puro). Entrada de estoque (compra/reposição) — RF-09.
// Custo do produto é cadastrado no fornecedor (product_suppliers), não aqui.
// `supplierId` é só REFERÊNCIA (opcional) a quem entregou o lote — nunca duplica
// preço; o preço da entrada é reconstruído a partir do histórico de preço do
// fornecedor na data da entrada.
export interface StockEntry {
  id: string;
  productId: string;
  quantity: number;
  entryDate: number; // epoch ms
  notes?: string;
  supplierId?: string;
  needsSync: boolean;
  syncedAt?: number;
}

export interface NewStockEntry {
  productId: string;
  quantity: number;
  notes?: string;
  supplierId?: string;
  entryDate?: number; // default: agora
}
