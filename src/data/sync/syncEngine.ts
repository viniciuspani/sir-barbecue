import { eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { db } from '@/data/local/database';
import {
  categories,
  productSuppliers,
  products,
  saleItems,
  sales,
  stockEntries,
  stockItems,
  suppliers,
} from '@/data/local/schema';
import { supabase } from '@/data/remote/supabaseClient';
import { useAuthStore } from '@/store/authStore';
import { useSyncStore } from '@/store/syncStore';

const MAX_ATTEMPTS = 3;

type RemoteProduct = {
  client_id: string;
  name: string;
  price: number;
  is_active: boolean;
  category_client_id: string | null;
};
type RemoteCategory = { client_id: string; name: string };
type RemoteSupplier = {
  client_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
};
type RemoteStockItem = { product_client_id: string; quantity: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 3 tentativas com backoff exponencial: 1s, 2s, 4s (doc 01b §7.4).
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS - 1) await delay(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

// Idempotência: upsert no servidor com ON CONFLICT (client_id).
async function upsertRemote(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from(table).upsert(rows, { onConflict: 'client_id' });
  if (error) throw new Error(`[sync:${table}] ${error.message}`);
}

// ---- PUSH (local → servidor) -------------------------------------------------

async function pushProducts(tenantId: string): Promise<void> {
  const rows = await db.select().from(products).where(eq(products.needsSync, true));
  if (rows.length === 0) return;
  await withRetry(() =>
    upsertRemote(
      'products',
      rows.map((r) => ({
        client_id: r.id,
        tenant_id: tenantId,
        name: r.name,
        price: r.price,
        is_active: r.isActive,
        category_client_id: r.categoryId,
      })),
    ),
  );
  await db
    .update(products)
    .set({ needsSync: false, syncedAt: Date.now() })
    .where(eq(products.needsSync, true));
}

async function pushSuppliers(tenantId: string): Promise<void> {
  const rows = await db.select().from(suppliers).where(eq(suppliers.needsSync, true));
  if (rows.length === 0) return;
  await withRetry(() =>
    upsertRemote(
      'suppliers',
      rows.map((r) => ({
        client_id: r.id,
        tenant_id: tenantId,
        name: r.name,
        contact_name: r.contactName,
        phone: r.phone,
        address: r.address,
      })),
    ),
  );
  await db
    .update(suppliers)
    .set({ needsSync: false, syncedAt: Date.now() })
    .where(eq(suppliers.needsSync, true));
}

// Associação N:N (normalizada): sem tenant_id; FK por product/supplier (devem já ter subido).
async function pushProductSuppliers(): Promise<void> {
  const rows = await db.select().from(productSuppliers).where(eq(productSuppliers.needsSync, true));
  if (rows.length === 0) return;
  await withRetry(() =>
    upsertRemote(
      'product_suppliers',
      rows.map((r) => ({
        client_id: r.id,
        product_client_id: r.productId,
        supplier_client_id: r.supplierId,
        purchase_price: r.purchasePrice,
        is_preferred: r.isPreferred,
      })),
    ),
  );
  await db
    .update(productSuppliers)
    .set({ needsSync: false, syncedAt: Date.now() })
    .where(eq(productSuppliers.needsSync, true));
}

async function pushSales(tenantId: string): Promise<void> {
  const rows = await db.select().from(sales).where(eq(sales.needsSync, true));
  if (rows.length === 0) return;
  await withRetry(() =>
    upsertRemote(
      'sales',
      rows.map((r) => ({
        client_id: r.id,
        tenant_id: tenantId,
        sale_date: new Date(r.saleDate).toISOString(),
        total_amount: r.totalAmount,
        payment_method: r.paymentMethod,
        consumption_mode: r.consumptionMode,
      })),
    ),
  );
  await db
    .update(sales)
    .set({ needsSync: false, syncedAt: Date.now() })
    .where(eq(sales.needsSync, true));
}

// Tabela FILHA (normalizada): herda o tenant do pai (sales). NÃO envia tenant_id.
async function pushSaleItems(): Promise<void> {
  const rows = await db.select().from(saleItems).where(eq(saleItems.needsSync, true));
  if (rows.length === 0) return;
  await withRetry(() =>
    upsertRemote(
      'sale_items',
      rows.map((r) => ({
        client_id: r.id,
        sale_client_id: r.saleId,
        product_client_id: r.productId,
        quantity: r.quantity,
        unit_price: r.unitPrice,
      })),
    ),
  );
  await db
    .update(saleItems)
    .set({ needsSync: false, syncedAt: Date.now() })
    .where(eq(saleItems.needsSync, true));
}

// Estoque: o servidor RECALCULA a quantidade (triggers increment_stock_on_entry /
// deduct_stock_on_sale). O app envia apenas as ENTRADAS (não a quantidade do stock_items).
async function pushStockEntries(tenantId: string): Promise<void> {
  const rows = await db.select().from(stockEntries).where(eq(stockEntries.needsSync, true));
  if (rows.length === 0) return;
  await withRetry(() =>
    upsertRemote(
      'stock_entries',
      rows.map((r) => ({
        client_id: r.id,
        tenant_id: tenantId,
        product_client_id: r.productId,
        quantity: r.quantity,
        unit_cost: r.unitCost,
        entry_date: new Date(r.entryDate).toISOString(),
        notes: r.notes,
      })),
    ),
  );
  await db
    .update(stockEntries)
    .set({ needsSync: false, syncedAt: Date.now() })
    .where(eq(stockEntries.needsSync, true));
}

// alert_threshold é CONFIG do cliente → atualiza o stock_items no servidor por product_client_id
// (a linha é criada pela entrada). A quantidade é server-owned (reconciliada no pull).
async function pushStockThresholds(tenantId: string): Promise<void> {
  const rows = await db.select().from(stockItems).where(eq(stockItems.needsSync, true));
  if (rows.length === 0) return;
  for (const r of rows) {
    await withRetry(async () => {
      const { error } = await supabase
        .from('stock_items')
        .update({ alert_threshold: r.alertThreshold })
        .eq('tenant_id', tenantId)
        .eq('product_client_id', r.productId);
      if (error) throw new Error(`[sync:stock_items] ${error.message}`);
    });
  }
  await db.update(stockItems).set({ needsSync: false }).where(eq(stockItems.needsSync, true));
}

// ---- PULL (servidor → local, server-wins) ------------------------------------

// Categorias: server-wins (servidor é dono do catálogo — Opção A). Filtra pela empresa ativa.
async function pullCategories(tenantId: string): Promise<void> {
  const { data, error } = await supabase
    .from('categories')
    .select('client_id, name')
    .eq('tenant_id', tenantId)
    .returns<RemoteCategory[]>();
  if (error) throw new Error(`[sync:pull categories] ${error.message}`);
  if (!data) return;
  const now = Date.now();
  for (const r of data) {
    await db
      .insert(categories)
      .values({ id: r.client_id, name: r.name, needsSync: false, syncedAt: now })
      .onConflictDoUpdate({
        target: categories.id,
        set: { name: r.name, needsSync: false, syncedAt: now },
      });
  }
}

// Catálogo: server-wins (doc 01c §10.3). Filtra pela empresa ativa.
async function pullProducts(tenantId: string): Promise<void> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('tenant_id', tenantId)
    .returns<RemoteProduct[]>();
  if (error) throw new Error(`[sync:pull products] ${error.message}`);
  if (!data) return;
  const now = Date.now();
  for (const r of data) {
    await db
      .insert(products)
      .values({
        id: r.client_id,
        name: r.name,
        price: r.price,
        isActive: r.is_active,
        categoryId: r.category_client_id ?? null,
        needsSync: false,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: products.id,
        set: {
          name: r.name,
          price: r.price,
          isActive: r.is_active,
          categoryId: r.category_client_id ?? null,
          needsSync: false,
          syncedAt: now,
        },
      });
  }
}

async function pullSuppliers(tenantId: string): Promise<void> {
  const { data, error } = await supabase
    .from('suppliers')
    .select('client_id, name, contact_name, phone, address')
    .eq('tenant_id', tenantId)
    .returns<RemoteSupplier[]>();
  if (error) throw new Error(`[sync:pull suppliers] ${error.message}`);
  if (!data) return;
  const now = Date.now();
  for (const r of data) {
    const set = {
      name: r.name,
      contactName: r.contact_name ?? null,
      phone: r.phone ?? null,
      address: r.address ?? null,
      needsSync: false,
      syncedAt: now,
    };
    await db
      .insert(suppliers)
      .values({ id: r.client_id, ...set })
      .onConflictDoUpdate({ target: suppliers.id, set });
  }
}

// Estoque: server-wins na QUANTIDADE; preserva o alert_threshold local (config do cliente).
async function pullStockItems(tenantId: string): Promise<void> {
  const { data, error } = await supabase
    .from('stock_items')
    .select('product_client_id, quantity')
    .eq('tenant_id', tenantId)
    .returns<RemoteStockItem[]>();
  if (error) throw new Error(`[sync:pull stock_items] ${error.message}`);
  if (!data) return;
  const now = Date.now();
  for (const r of data) {
    const existing = await db
      .select()
      .from(stockItems)
      .where(eq(stockItems.productId, r.product_client_id));
    if (existing.length) {
      await db
        .update(stockItems)
        .set({ quantity: r.quantity, needsSync: false, syncedAt: now })
        .where(eq(stockItems.productId, r.product_client_id));
    } else {
      await db.insert(stockItems).values({
        id: Crypto.randomUUID(),
        productId: r.product_client_id,
        quantity: r.quantity,
        alertThreshold: 0,
        needsSync: false,
        syncedAt: now,
      });
    }
  }
}

// ---- Orquestração ------------------------------------------------------------

async function countPending(): Promise<number> {
  const [p, sup, ps, s, si, se, st] = await Promise.all([
    db.select().from(products).where(eq(products.needsSync, true)),
    db.select().from(suppliers).where(eq(suppliers.needsSync, true)),
    db.select().from(productSuppliers).where(eq(productSuppliers.needsSync, true)),
    db.select().from(sales).where(eq(sales.needsSync, true)),
    db.select().from(saleItems).where(eq(saleItems.needsSync, true)),
    db.select().from(stockEntries).where(eq(stockEntries.needsSync, true)),
    db.select().from(stockItems).where(eq(stockItems.needsSync, true)),
  ]);
  return p.length + sup.length + ps.length + s.length + si.length + se.length + st.length;
}

export async function refreshPendingCount(): Promise<void> {
  try {
    useSyncStore.getState().setPending(await countPending());
  } catch {
    // ignore
  }
}

let running = false;

/**
 * Orquestra o sync. Requer sessão + empresa ativa (tenant) + conectividade.
 * Sem isso (ou se o backend ainda não tem as tabelas), os dados ficam pendentes.
 */
export async function runSync(): Promise<void> {
  if (running) return;
  const { data } = await supabase.auth.getSession();
  if (!data.session) return;

  const tenantId = useAuthStore.getState().currentTenantId;
  if (!tenantId) return; // sem empresa ativa → nada a sincronizar com o servidor

  running = true;
  const store = useSyncStore.getState();
  store.setStatus('syncing');
  try {
    // Ordem importa (FKs por client_id no servidor):
    // produtos/fornecedores → associações → vendas/itens → entradas/limite de estoque.
    await pushProducts(tenantId);
    await pushSuppliers(tenantId);
    await pushProductSuppliers();
    await pushSales(tenantId);
    await pushSaleItems();
    await pushStockEntries(tenantId);
    await pushStockThresholds(tenantId);
    // Pulls server-wins (depois dos pushes, para a quantidade já refletir as vendas/entradas).
    await pullCategories(tenantId);
    await pullProducts(tenantId);
    await pullSuppliers(tenantId);
    await pullStockItems(tenantId);
    store.markSynced();
  } catch (e) {
    console.warn('[sync] falhou', e);
    store.setStatus('error');
    await refreshPendingCount();
  } finally {
    running = false;
  }
}
