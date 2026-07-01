import { desc, eq } from 'drizzle-orm';
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
    unitCost: row.unitCost ?? undefined,
    entryDate: row.entryDate,
    notes: row.notes ?? undefined,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

/** Implementação do StockRepository sobre Drizzle + expo-sqlite (Plano B). */
export class DrizzleStockRepository implements StockRepository {
  async getItem(productId: string): Promise<StockItem | null> {
    const rows = await db.select().from(stockItems).where(eq(stockItems.productId, productId));
    return rows.length ? toItem(rows[0]) : null;
  }

  async registerEntry(input: NewStockEntry): Promise<void> {
    const entryDate = input.entryDate ?? Date.now();
    await db.transaction(async (tx) => {
      await tx.insert(stockEntries).values({
        id: Crypto.randomUUID(),
        productId: input.productId,
        quantity: input.quantity,
        unitCost: input.unitCost ?? null,
        notes: input.notes ?? null,
        entryDate,
        needsSync: true,
      });
      const existing = await tx
        .select()
        .from(stockItems)
        .where(eq(stockItems.productId, input.productId));
      if (existing.length) {
        await tx
          .update(stockItems)
          .set({ quantity: existing[0].quantity + input.quantity, needsSync: true })
          .where(eq(stockItems.productId, input.productId));
      } else {
        await tx.insert(stockItems).values({
          id: Crypto.randomUUID(),
          productId: input.productId,
          quantity: input.quantity,
          alertThreshold: 0,
          needsSync: true,
        });
      }
    });
  }

  async setAlertThreshold(productId: string, threshold: number): Promise<void> {
    const existing = await db.select().from(stockItems).where(eq(stockItems.productId, productId));
    if (existing.length) {
      await db
        .update(stockItems)
        .set({ alertThreshold: threshold, needsSync: true })
        .where(eq(stockItems.productId, productId));
    } else {
      await db.insert(stockItems).values({
        id: Crypto.randomUUID(),
        productId,
        quantity: 0,
        alertThreshold: threshold,
        needsSync: true,
      });
    }
  }

  async listEntries(productId: string): Promise<StockEntry[]> {
    const rows = await db
      .select()
      .from(stockEntries)
      .where(eq(stockEntries.productId, productId))
      .orderBy(desc(stockEntries.entryDate));
    return rows.map(toEntry);
  }

  async deductForSale(items: { productId: string; quantity: number }[]): Promise<void> {
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
            .set({ quantity: next, needsSync: true })
            .where(eq(stockItems.productId, it.productId));
        }
      }
    });
  }

  observeItems(onChange: (items: StockItem[]) => void): () => void {
    const emit = () => {
      db.select()
        .from(stockItems)
        .then((rows) => onChange(rows.map(toItem)))
        .catch(() => undefined);
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'stock_items') emit();
    });
    return () => subscription.remove();
  }
}
