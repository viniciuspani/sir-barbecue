import { and, desc, eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import {
  stockEntries,
  stockItems,
  type StockEntryRow,
  type StockItemRow,
} from '@/data/local/schema';
import type { NewStockEntry, StockEntry } from '@/domain/entities/StockEntry';
import type { StockItem } from '@/domain/entities/StockItem';
import type { StockRepository } from '@/domain/repositories/StockRepository';
import { getActiveTenantId, getActiveTenantIdOrThrow } from '@/lib/activeTenant';
import { logSilently } from '@/lib/feedback';

function toItem(row: StockItemRow): StockItem {
  return {
    id: row.id,
    productId: row.productId,
    quantity: row.quantity,
    alertThreshold: row.alertThreshold,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

function toEntry(row: StockEntryRow): StockEntry {
  return {
    id: row.id,
    productId: row.productId,
    quantity: row.quantity,
    entryDate: row.entryDate,
    notes: row.notes ?? undefined,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

/** Implementação do StockRepository sobre Drizzle + expo-sqlite (Plano B). */
export class DrizzleStockRepository implements StockRepository {
  async getItem(productId: string): Promise<StockItem | null> {
    const tenantId = getActiveTenantId();
    if (!tenantId) return null;
    const rows = await db
      .select()
      .from(stockItems)
      .where(and(eq(stockItems.productId, productId), eq(stockItems.tenantId, tenantId)));
    return rows.length ? toItem(rows[0]) : null;
  }

  async registerEntry(input: NewStockEntry): Promise<void> {
    const tenantId = getActiveTenantIdOrThrow();
    const entryDate = input.entryDate ?? Date.now();
    await db.transaction(async (tx) => {
      await tx.insert(stockEntries).values({
        id: Crypto.randomUUID(),
        productId: input.productId,
        quantity: input.quantity,
        notes: input.notes ?? null,
        entryDate,
        tenantId,
        needsSync: true,
      });
      const existing = await tx
        .select()
        .from(stockItems)
        .where(eq(stockItems.productId, input.productId));
      if (existing.length) {
        await tx
          .update(stockItems)
          .set({ quantity: existing[0].quantity + input.quantity, tenantId, needsSync: true })
          .where(eq(stockItems.productId, input.productId));
      } else {
        await tx.insert(stockItems).values({
          id: Crypto.randomUUID(),
          productId: input.productId,
          quantity: input.quantity,
          alertThreshold: 0,
          tenantId,
          needsSync: true,
        });
      }
    });
  }

  async setAlertThreshold(productId: string, threshold: number): Promise<void> {
    const tenantId = getActiveTenantIdOrThrow();
    const existing = await db.select().from(stockItems).where(eq(stockItems.productId, productId));
    if (existing.length) {
      await db
        .update(stockItems)
        .set({ alertThreshold: threshold, tenantId, needsSync: true })
        .where(eq(stockItems.productId, productId));
    } else {
      await db.insert(stockItems).values({
        id: Crypto.randomUUID(),
        productId,
        quantity: 0,
        alertThreshold: threshold,
        tenantId,
        needsSync: true,
      });
    }
  }

  async listEntries(productId: string): Promise<StockEntry[]> {
    const tenantId = getActiveTenantId();
    if (!tenantId) return [];
    const rows = await db
      .select()
      .from(stockEntries)
      .where(and(eq(stockEntries.productId, productId), eq(stockEntries.tenantId, tenantId)))
      .orderBy(desc(stockEntries.entryDate))
      .limit(10);
    return rows.map(toEntry);
  }

  async deductForSale(items: { productId: string; quantity: number }[]): Promise<void> {
    const tenantId = getActiveTenantIdOrThrow();
    await db.transaction(async (tx) => {
      for (const it of items) {
        const existing = await tx
          .select()
          .from(stockItems)
          .where(eq(stockItems.productId, it.productId));
        if (existing.length) {
          const next = Math.max(0, existing[0].quantity - it.quantity);
          await tx
            .update(stockItems)
            .set({ quantity: next, tenantId, needsSync: true })
            .where(eq(stockItems.productId, it.productId));
        }
      }
    });
  }

  observeItems(onChange: (items: StockItem[]) => void): () => void {
    const emit = () => {
      const tenantId = getActiveTenantId();
      if (!tenantId) {
        onChange([]);
        return;
      }
      db.select()
        .from(stockItems)
        .where(eq(stockItems.tenantId, tenantId))
        .then((rows) => onChange(rows.map(toItem)))
        .catch((e) => logSilently(e, { action: 'Carregar o estoque' }));
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'stock_items') emit();
    });
    return () => subscription.remove();
  }
}
