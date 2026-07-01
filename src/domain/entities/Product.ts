// Entidade de domínio (TS puro — sem dependência de framework/BD).
export interface Product {
  /** client_id (UUID gerado offline) — chave de idempotência do sync. */
  id: string;
  name: string;
  price: number;
  isActive: boolean;
  categoryId?: string;
  /** Dias da semana (0=dom..6=sáb) em que o produto aparece na venda. Vazio/undefined = todos (RF-05). */
  visibleDays?: number[];
  /** true = há alteração local ainda não sincronizada. */
  needsSync: boolean;
  /** epoch ms do último sync bem-sucedido. */
  syncedAt?: number;
}
