import { eq, inArray } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { kitchenTickets, salePayments, saleItems, sales } from '@/data/local/schema';
import type {
  ConsumptionMode,
  NewSale,
  PaymentMethod,
  Sale,
  SaleItem,
  SalePayment,
} from '@/domain/entities/Sale';
import type { SaleRepository } from '@/domain/repositories/SaleRepository';
import { getActiveTenantId, getActiveTenantIdOrThrow } from '@/lib/activeTenant';
import { logSilently } from '@/lib/feedback';

/**
 * Implementação do SaleRepository sobre Drizzle + expo-sqlite (Plano B).
 * Grava a venda localmente ANTES de qualquer confirmação ao usuário (RF-15 — não há perda de dados).
 */
export class DrizzleSaleRepository implements SaleRepository {
  async create(input: NewSale): Promise<Sale> {
    const tenantId = getActiveTenantIdOrThrow();
    const saleId = Crypto.randomUUID();
    const saleDate = input.saleDate ?? Date.now();
    const totalAmount = input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const items: SaleItem[] = input.items.map((i) => ({ id: Crypto.randomUUID(), ...i }));
    // Mesma regra do servidor (create_sale): 1 forma grava o método real, 2+
    // gravam 'split' — sale_payments é que guarda o detalhe de cada uma.
    const paymentMethod: PaymentMethod | 'split' =
      input.payments.length === 1 ? input.payments[0].method : 'split';

    await db.transaction(async (tx) => {
      await tx.insert(sales).values({
        id: saleId,
        saleDate,
        totalAmount,
        paymentMethod,
        consumptionMode: input.consumptionMode,
        tenantId,
        tabClientId: input.tabId,
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
      for (const payment of input.payments) {
        await tx.insert(salePayments).values({
          id: Crypto.randomUUID(),
          saleId,
          method: payment.method,
          amount: payment.amount,
          needsSync: true,
        });
      }
      // Pré-pago: gera o ticket de cozinha na MESMA transação. A comanda NÃO
      // fecha aqui — quem decide isso é o chamador (ver TabRepository.payPartial),
      // com base em ter sobrado item ou não.
      if (input.queue && input.tabId) {
        await tx.insert(kitchenTickets).values({
          id: Crypto.randomUUID(),
          saleId,
          tabId: input.tabId,
          customerName: input.customerName ?? '',
          items: JSON.stringify(input.items.map((i) => ({ name: i.name, quantity: i.quantity }))),
          status: 'pending',
          createdAt: saleDate,
          tenantId,
          needsSync: true,
        });
      }
    });

    return {
      id: saleId,
      saleDate,
      totalAmount,
      paymentMethod,
      payments: input.payments,
      consumptionMode: input.consumptionMode,
      needsSync: true,
      items,
    };
  }

  async list(): Promise<Sale[]> {
    // Só vendas da empresa ativa (Home/Relatórios não mostram dados de outra empresa).
    const tenantId = getActiveTenantId();
    if (!tenantId) return [];
    const saleRows = await db.select().from(sales).where(eq(sales.tenantId, tenantId));
    if (saleRows.length === 0) return [];
    const ids = saleRows.map((s) => s.id);
    const itemRows = await db.select().from(saleItems).where(inArray(saleItems.saleId, ids));
    const paymentRows = await db.select().from(salePayments).where(inArray(salePayments.saleId, ids));

    return saleRows.map((s) => ({
      id: s.id,
      saleDate: s.saleDate,
      totalAmount: s.totalAmount,
      paymentMethod: s.paymentMethod as PaymentMethod | 'split',
      payments: paymentRows
        .filter((p) => p.saleId === s.id)
        .map((p): SalePayment => ({ method: p.method as PaymentMethod, amount: p.amount })),
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
      this.list()
        .then(onChange)
        .catch((e) => logSilently(e, { action: 'Carregar vendas' }));
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (['sales', 'sale_items', 'sale_payments'].includes(event.tableName)) emit();
    });
    return () => subscription.remove();
  }
}
