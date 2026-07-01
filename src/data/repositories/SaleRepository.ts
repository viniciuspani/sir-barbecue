import { inArray } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { saleItems, sales } from '@/data/local/schema';
import type {
  ConsumptionMode,
  NewSale,
  PaymentMethod,
  Sale,
  SaleItem,
} from '@/domain/entities/Sale';
import type { SaleRepository } from '@/domain/repositories/SaleRepository';

/**
 * Implementação do SaleRepository sobre Drizzle + expo-sqlite (Plano B).
 * Grava a venda localmente ANTES de qualquer confirmação ao usuário (RF-15 — não há perda de dados).
 */
export class DrizzleSaleRepository implements SaleRepository {
  async create(input: NewSale): Promise<Sale> {
    const saleId = Crypto.randomUUID();
    const saleDate = input.saleDate ?? Date.now();
    const totalAmount = input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const items: SaleItem[] = input.items.map((i) => ({ id: Crypto.randomUUID(), ...i }));

    await db.transaction(async (tx) => {
      await tx.insert(sales).values({
        id: saleId,
        saleDate,
        totalAmount,
        paymentMethod: input.paymentMethod,
        consumptionMode: input.consumptionMode,
        needsSync: true,
      });
      for (const item of items) {
        await tx.insert(saleItems).values({
          id: item.id,
          saleId,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          needsSync: true,
        });
      }
    });

    return {
      id: saleId,
      saleDate,
      totalAmount,
      paymentMethod: input.paymentMethod,
      consumptionMode: input.consumptionMode,
      needsSync: true,
      items,
    };
  }

  async list(): Promise<Sale[]> {
    const saleRows = await db.select().from(sales);
    if (saleRows.length === 0) return [];
    const ids = saleRows.map((s) => s.id);
    const itemRows = await db.select().from(saleItems).where(inArray(saleItems.saleId, ids));

    return saleRows.map((s) => ({
      id: s.id,
      saleDate: s.saleDate,
      totalAmount: s.totalAmount,
      paymentMethod: s.paymentMethod as PaymentMethod,
      consumptionMode: s.consumptionMode as ConsumptionMode,
      needsSync: s.needsSync,
      syncedAt: s.syncedAt ?? undefined,
      items: itemRows
        .filter((it) => it.saleId === s.id)
        .map((it) => ({
          id: it.id,
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
    }));
  }

  observeAll(onChange: (items: Sale[]) => void): () => void {
    const emit = () => {
      this.list().then(onChange).catch(() => undefined);
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'sales' || event.tableName === 'sale_items') emit();
    });
    return () => subscription.remove();
  }
}
