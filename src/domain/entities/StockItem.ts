// Entidade de domínio (TS puro). Saldo atual de estoque por produto.
export interface StockItem {
  id: string;
  productId: string;
  quantity: number;
  /** Saldo <= isto (e > 0) dispara alerta de estoque baixo (RF-11). 0 = sem alerta. */
  alertThreshold: number;
  needsSync: boolean;
  syncedAt?: number;
}
