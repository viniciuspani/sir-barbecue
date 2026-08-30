import { and, asc, eq, inArray } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { tabItems, tabs, type TabItemRow, type TabRow } from '@/data/local/schema';
import type { NewTabItem, Tab } from '@/domain/entities/Tab';
import type { TabRepository } from '@/domain/repositories/TabRepository';
import { getActiveTenantId, getActiveTenantIdOrThrow } from '@/lib/activeTenant';
import { logSilently } from '@/lib/feedback';

function toTab(row: TabRow, itemRows: TabItemRow[]): Tab {
  return {
    id: row.id,
    customerName: row.customerName,
    openedAt: row.openedAt,
    items: itemRows
      .filter((it) => it.tabId === row.id && !it.pendingDelete)
      .map((it) => ({
        id: it.id,
        productId: it.productId,
        name: it.name,
        unitPrice: it.unitPrice,
        quantity: it.quantity,
      })),
  };
}

/**
 * Implementação do TabRepository sobre Drizzle + expo-sqlite.
 *
 * Desde a F5 do plano web as comandas SINCRONIZAM (o balcão pode ser atendido
 * pelo Android e pelo PWA no iPhone ao mesmo tempo). Duas consequências no
 * comportamento local:
 *  - fechar/descartar MARCA a comanda como 'closed' em vez de apagá-la: o
 *    fechamento precisa chegar ao servidor mesmo que o aparelho esteja offline;
 *  - remover item MARCA `pending_delete` em vez de apagar: sem isso o outro
 *    aparelho traria o item de volta no próximo pull.
 * O sync apaga as linhas locais depois de propagar (ver syncEngine).
 */
export class DrizzleTabRepository implements TabRepository {
  async open(customerName: string): Promise<Tab> {
    const id = Crypto.randomUUID();
    const openedAt = Date.now();
    await db.insert(tabs).values({
      id,
      customerName: customerName.trim(),
      openedAt,
      status: 'open',
      tenantId: getActiveTenantIdOrThrow(),
      needsSync: true,
    });
    return { id, customerName: customerName.trim(), openedAt, items: [] };
  }

  async get(tabId: string): Promise<Tab | null> {
    const rows = await db.select().from(tabs).where(eq(tabs.id, tabId));
    if (!rows.length) return null;
    const itemRows = await db.select().from(tabItems).where(eq(tabItems.tabId, tabId));
    return toTab(rows[0], itemRows);
  }

  /** Comandas ABERTAS da empresa ativa (mais antiga primeiro), com itens. */
  async list(): Promise<Tab[]> {
    const tenantId = getActiveTenantId();
    if (!tenantId) return [];
    const tabRows = await db
      .select()
      .from(tabs)
      .where(and(eq(tabs.status, 'open'), eq(tabs.tenantId, tenantId)))
      .orderBy(asc(tabs.openedAt));
    if (tabRows.length === 0) return [];
    const ids = tabRows.map((t) => t.id);
    const itemRows = await db.select().from(tabItems).where(inArray(tabItems.tabId, ids));
    return tabRows.map((t) => toTab(t, itemRows));
  }

  async addItem(tabId: string, item: NewTabItem, quantity = 1): Promise<void> {
    const existing = await db.select().from(tabItems).where(eq(tabItems.tabId, tabId));
    const line = existing.find((it) => it.productId === item.productId);
    if (line) {
      // Reaproveita a linha marcada para exclusão: o produto voltou à comanda
      // antes de o sync propagar a remoção.
      await db
        .update(tabItems)
        .set({
          quantity: (line.pendingDelete ? 0 : line.quantity) + quantity,
          pendingDelete: false,
          needsSync: true,
        })
        .where(eq(tabItems.id, line.id));
    } else {
      await db.insert(tabItems).values({
        id: Crypto.randomUUID(),
        tabId,
        productId: item.productId,
        name: item.name,
        unitPrice: item.unitPrice,
        quantity,
        needsSync: true,
      });
    }
    await this.touch(tabId);
  }

  async decrementItem(tabId: string, productId: string): Promise<void> {
    const rows = await db.select().from(tabItems).where(eq(tabItems.tabId, tabId));
    const line = rows.find((it) => it.productId === productId && !it.pendingDelete);
    if (!line) return;
    if (line.quantity <= 1) {
      await db
        .update(tabItems)
        .set({ pendingDelete: true, needsSync: true })
        .where(eq(tabItems.id, line.id));
    } else {
      await db
        .update(tabItems)
        .set({ quantity: line.quantity - 1, needsSync: true })
        .where(eq(tabItems.id, line.id));
    }
    await this.touch(tabId);
  }

  /** Encerra a comanda (paga ou descartada). O sync leva o fechamento adiante. */
  async close(tabId: string): Promise<void> {
    await db
      .update(tabs)
      .set({ status: 'closed', closedAt: Date.now(), needsSync: true })
      .where(eq(tabs.id, tabId));
  }

  observeAll(onChange: (tabs: Tab[]) => void): () => void {
    const emit = () => {
      this.list()
        .then(onChange)
        .catch((e) => logSilently(e, { action: 'Carregar comandas' }));
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'tabs' || event.tableName === 'tab_items') emit();
    });
    return () => subscription.remove();
  }

  /**
   * Marca a comanda para subir quando só os itens mudaram. O servidor não guarda
   * "última alteração de item" na comanda, mas manter a marca aqui garante que
   * uma comanda criada offline suba junto com seus itens.
   */
  private async touch(tabId: string): Promise<void> {
    await db.update(tabs).set({ needsSync: true }).where(eq(tabs.id, tabId));
  }
}
