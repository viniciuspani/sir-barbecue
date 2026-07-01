// Entidade de domínio (TS puro — sem dependência de framework/BD).
export interface Category {
  /** client_id (UUID gerado offline) — chave de idempotência do sync. */
  id: string;
  name: string;
  /** true = há alteração local ainda não sincronizada. */
  needsSync: boolean;
  /** epoch ms do último sync bem-sucedido. */
  syncedAt?: number;
}
