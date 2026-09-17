import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { tabItems, tabs, type TabItemRow, type TabRow } from '@/data/local/schema';
import { QUEUE_STATUSES, type NewTabItem, type Tab, type TabStatus } from '@/domain/entities/Tab';
import type { TabRepository } from '@/domain/repositories/TabRepository';
import { getActiveTenantId, getActiveTenantIdOrThrow } from '@/lib/activeTenant';
import { logSilently } from '@/lib/feedback';

function toTab(row: TabRow, itemRows: TabItemRow[]): Tab {
  return {
    id: row.id,
    customerName: row.customerName,
    openedAt: row.openedAt,
    status: row.status as TabStatus,
    paidAt: row.paidAt ?? undefined,
    readyAt: row.readyAt ?? undefined,
    saleId: row.saleId ?? undefined,
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
 *  - encerrar/descartar MARCA a comanda ('closed'/'cancelled') em vez de apagá-la:
 *    o fechamento precisa chegar ao servidor mesmo que o aparelho esteja offline;
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
    return { id, customerName: customerName.trim(), openedAt, status: 'open', items: [] };
  }

  async get(tabId: string): Promise<Tab | null> {
    const rows = await db.select().from(tabs).where(eq(tabs.id, tabId));
    if (!rows.length) return null;
    const itemRows = await db.select().from(tabItems).where(eq(tabItems.tabId, tabId));
    return toTab(rows[0], itemRows);
  }

  /**
   * Comandas ABERTAS da empresa ativa (mais antiga primeiro), com itens.
   *
   * Comanda paga fica DE FORA de propósito: esta lista alimenta a reserva de
   * estoque (src/lib/saleStock.ts) e a venda já deduziu o saldo dela. Contá-la
   * aqui subtrairia o produto duas vezes do disponível.
   */
  async list(): Promise<Tab[]> {
    return this.listByStatus(['open'], tabs.openedAt);
  }

  /** Fila da churrasqueira: pedidos pagos, pagamento mais antigo primeiro. */
  async listQueue(): Promise<Tab[]> {
    return this.listByStatus([...QUEUE_STATUSES], tabs.paidAt);
  }

  /** Comandas da empresa ativa nos status pedidos, com itens, na ordem de atendimento. */
  private async listByStatus(statuses: TabStatus[], orderBy: SQLiteColumn): Promise<Tab[]> {
    const tenantId = getActiveTenantId();
    if (!tenantId) return [];
    const tabRows = await db
      .select()
      .from(tabs)
      .where(and(inArray(tabs.status, statuses), eq(tabs.tenantId, tenantId)))
      .orderBy(asc(orderBy));
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

  /**
   * Pré-pago: o cliente pagou e o pedido foi para a grelha. A comanda SAI da
   * lista de abertas (não reserva mais estoque — a venda já deduziu) e entra na
   * fila da churrasqueira, visível no aparelho de quem assa pelo tempo real.
   */
  async markPaid(tabId: string, saleId: string): Promise<void> {
    await db
      .update(tabs)
      .set({ status: 'paid', paidAt: Date.now(), saleId, needsSync: true })
      .where(eq(tabs.id, tabId));
  }

  /** Saiu da grelha, aguardando o cliente retirar. */
  async markReady(tabId: string): Promise<void> {
    await db
      .update(tabs)
      .set({ status: 'ready', readyAt: Date.now(), needsSync: true })
      .where(eq(tabs.id, tabId));
  }

  /**
   * Entregue ao cliente: encerra a comanda. O sync leva o fechamento adiante.
   *
   * `saleId` vem do pagamento que encerrou a comanda na hora (o fluxo de
   * sempre). Vindo da fila da churrasqueira ele é omitido — a comanda já foi
   * amarrada à venda no `markPaid`, e sobrescrever com undefined perderia o elo.
   */
  async markDelivered(tabId: string, saleId?: string): Promise<void> {
    await this.finish(tabId, 'closed', saleId);
  }

  /** Descartada sem pagamento — não virou venda. */
  async cancel(tabId: string): Promise<void> {
    await this.finish(tabId, 'cancelled');
  }

  observeAll(onChange: (tabs: Tab[]) => void): () => void {
    return this.observe(() => this.list(), 'Carregar comandas', onChange);
  }

  observeQueue(onChange: (tabs: Tab[]) => void): () => void {
    return this.observe(() => this.listQueue(), 'Carregar a fila da churrasqueira', onChange);
  }

  private async finish(
    tabId: string,
    status: 'closed' | 'cancelled',
    saleId?: string,
  ): Promise<void> {
    await db
      .update(tabs)
      .set({ status, closedAt: Date.now(), needsSync: true, ...(saleId ? { saleId } : {}) })
      .where(eq(tabs.id, tabId));
  }

  private observe(
    load: () => Promise<Tab[]>,
    action: string,
    onChange: (tabs: Tab[]) => void,
  ): () => void {
    const emit = () => {
      load()
        .then(onChange)
        .catch((e) => logSilently(e, { action }));
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
