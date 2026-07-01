// Entidade de domínio (TS puro). Entrada de estoque (compra/reposição) — RF-09.
export interface StockEntry {
  id: string;
  productId: string;
  quantity: number;
  /** Custo unitário da entrada (opcional). */
  unitCost?: number;
  entryDate: number; // epoch ms
  notes?: string;
  needsSync: boolean;
  syncedAt?: number;
}

export interface NewStockEntry {
  productId: string;
  quantity: number;
  unitCost?: number;
  notes?: string;
  entryDate?: number; // default: agora
}
