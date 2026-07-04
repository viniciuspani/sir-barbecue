import { asc, eq, inArray } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { tabItems, tabs, type TabItemRow, type TabRow } from '@/data/local/schema';
import type { NewTabItem, Tab } from '@/domain/entities/Tab';
import type { TabRepository } from '@/domain/repositories/TabRepository';

function toTab(row: TabRow, itemRows: TabItemRow[]): Tab {
  return {
    id: row.id,
    customerName: row.customerName,
    openedAt: row.openedAt,
    items: itemRows
      .filter((it) => it.tabId === row.id)
      .map((it) => ({
        id: it.id,
        productId: it.productId,
        name: it.name,
        unitPrice: it.unitPrice,
        quantity: it.quantity,
      })),
  };
}

/** Implementação do TabRepository sobre Drizzle + expo-sqlite (local, sem sync). */
export class DrizzleTabRepository implements TabRepository {
  async open(customerName: string): Promise<Tab> {
    const id = Crypto.randomUUID();
    const openedAt = Date.now();
    await db.insert(tabs).values({ id, customerName: customerName.trim(), openedAt });
    return { id, customerName: customerName.trim(), openedAt, items: [] };
  }

  async get(tabId: string): Promise<Tab | null> {
    const rows = await db.select().from(tabs).where(eq(tabs.id, tabId));
    if (!rows.length) return null;
    const itemRows = await db.select().from(tabItems).where(eq(tabItems.tabId, tabId));
    return toTab(rows[0], itemRows);
  }

  async list(): Promise<Tab[]> {
    const tabRows = await db.select().from(tabs).orderBy(asc(tabs.openedAt));
    if (tabRows.length === 0) return [];
    const ids = tabRows.map((t) => t.id);
    const itemRows = await db.select().from(tabItems).where(inArray(tabItems.tabId, ids));
    return tabRows.map((t) => toTab(t, itemRows));
  }

  async addItem(tabId: string, item: NewTabItem, quantity = 1): Promise<void> {
    const existing = await db
      .select()
      .from(tabItems)
      .where(eq(tabItems.tabId, tabId));
    const line = existing.find((it) => it.productId === item.productId);
    if (line) {
      await db
        .update(tabItems)
        .set({ quantity: line.quantity + quantity })
        .where(eq(tabItems.id, line.id));
    } else {
      await db.insert(tabItems).values({
        id: Crypto.randomUUID(),
        tabId,
        productId: item.productId,
        name: item.name,
        unitPrice: item.unitPrice,
        quantity,
      });
    }
  }

  async decrementItem(tabId: string, productId: string): Promise<void> {
    const rows = await db.select().from(tabItems).where(eq(tabItems.tabId, tabId));
    const line = rows.find((it) => it.productId === productId);
    if (!line) return;
    if (line.quantity <= 1) {
      await db.delete(tabItems).where(eq(tabItems.id, line.id));
    } else {
      await db
        .update(tabItems)
        .set({ quantity: line.quantity - 1 })
        .where(eq(tabItems.id, line.id));
    }
  }

  async close(tabId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(tabItems).where(eq(tabItems.tabId, tabId));
      await tx.delete(tabs).where(eq(tabs.id, tabId));
    });
  }

  observeAll(onChange: (tabs: Tab[]) => void): () => void {
    const emit = () => {
      this.list().then(onChange).catch(() => undefined);
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'tabs' || event.tableName === 'tab_items') emit();
    });
    return () => subscription.remove();
  }
}
