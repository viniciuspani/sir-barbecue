// Entidades de domínio de Venda (TS puro). Offline-first (RF-12..16).

export type PaymentMethod = 'pix' | 'cash' | 'credit_card' | 'debit_card';
export type ConsumptionMode = 'on_site' | 'takeaway';

export interface SaleItem {
  id: string; // client_id
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface Sale {
  id: string; // client_id (idempotência)
  saleDate: number; // epoch ms
  totalAmount: number;
  paymentMethod: PaymentMethod;
  consumptionMode: ConsumptionMode;
  needsSync: boolean;
  syncedAt?: number;
  items: SaleItem[];
}

export type NewSaleItem = Omit<SaleItem, 'id'>;

export interface NewSale {
  paymentMethod: PaymentMethod;
  consumptionMode: ConsumptionMode;
  items: NewSaleItem[];
  saleDate?: number; // default: agora
}
