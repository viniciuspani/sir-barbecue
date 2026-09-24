import { and, asc, eq, inArray } from 'drizzle-orm';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { kitchenTickets, type KitchenTicketRow } from '@/data/local/schema';
import type { KitchenTicket, KitchenTicketStatus } from '@/domain/entities/KitchenTicket';
import type { KitchenTicketRepository } from '@/domain/repositories/KitchenTicketRepository';
import { getActiveTenantId } from '@/lib/activeTenant';
import { logSilently } from '@/lib/feedback';

const QUEUE_STATUSES: KitchenTicketStatus[] = ['pending', 'ready'];

function toTicket(row: KitchenTicketRow): KitchenTicket {
  return {
    id: row.id,
    saleId: row.saleId,
    tabId: row.tabId,
    customerName: row.customerName,
    items: JSON.parse(row.items) as { name: string; quantity: number }[],
    status: row.status as KitchenTicketStatus,
    createdAt: row.createdAt,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

export class DrizzleKitchenTicketRepository implements KitchenTicketRepository {
  async list(): Promise<KitchenTicket[]> {
    const tenantId = getActiveTenantId();
    if (!tenantId) return [];
    const rows = await db
      .select()
      .from(kitchenTickets)
      .where(and(inArray(kitchenTickets.status, QUEUE_STATUSES), eq(kitchenTickets.tenantId, tenantId)))
      .orderBy(asc(kitchenTickets.createdAt));
    return rows.map(toTicket);
  }

  /**
   * O filtro por `status='pending'` não é decoração: dois aparelhos leem a
   * mesma fila, e sem ele um toque atrasado reabriria como "pronto" um
   * pedido que o outro já entregou.
   */
  async markReady(ticketId: string): Promise<void> {
    await db
      .update(kitchenTickets)
      .set({ status: 'ready', needsSync: true })
      .where(and(eq(kitchenTickets.id, ticketId), eq(kitchenTickets.status, 'pending')));
  }

  async markDelivered(ticketId: string): Promise<void> {
    await db
      .update(kitchenTickets)
      .set({ status: 'delivered', needsSync: true })
      .where(and(eq(kitchenTickets.id, ticketId), inArray(kitchenTickets.status, QUEUE_STATUSES)));
  }

  observeQueue(onChange: (tickets: KitchenTicket[]) => void): () => void {
    const emit = () => {
      this.list()
        .then(onChange)
        .catch((e) => logSilently(e, { action: 'Carregar a fila da churrasqueira' }));
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'kitchen_tickets') emit();
    });
    return () => subscription.remove();
  }
}
