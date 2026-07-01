// Entidade de domínio (TS puro). Fornecedor (RF-07).
export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  address?: string;
  needsSync: boolean;
  syncedAt?: number;
}
