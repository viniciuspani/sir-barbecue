// Entidade de domínio (TS puro). Entrada de estoque (compra/reposição) — RF-09.
// Custo do produto é cadastrado no fornecedor (product_suppliers), não aqui.
export interface StockEntry {
  id: string;
  productId: string;
  quantity: number;
  entryDate: number; // epoch ms
  notes?: string;
  needsSync: boolean;
  syncedAt?: number;
}

export interface NewStockEntry {
  productId: string;
  quantity: number;
  notes?: string;
  entryDate?: number; // default: agora
}
