import { and, eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { db } from '@/data/local/database';
import {
  categories,
  productSupplierPriceHistory,
  productSuppliers,
  products,
  saleItems,
  sales,
  stockEntries,
  stockItems,
  suppliers,
} from '@/data/local/schema';
import { supabase } from '@/data/remote/supabaseClient';
import { canWriteCatalog, canWriteSuppliers } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
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
type RemoteProductSupplier = {
  client_id: string;
  product_client_id: string;
  supplier_client_id: string;
  purchase_price: number;
  is_preferred: boolean;
  is_active: boolean;
};
type RemotePriceHistory = {
  client_id: string;
  product_client_id: string;
  supplier_client_id: string;
  purchase_price: number;
  is_preferred: boolean;
  recorded_at: string;
};

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

// Idempotência: upsert no servidor com ON CONFLICT (client_id por padrão).
// onConflict configurável: tabelas com chave natural própria (ex.: product_suppliers,
// que tem unique (product_client_id, supplier_client_id)) precisam conflitar por ela,
// senão um re-add com client_id novo tenta INSERT e viola a unique natural.
async function upsertRemote(
  table: string,
  rows: Record<string, unknown>[],
  onConflict = 'client_id',
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from(table).upsert(rows, { onConflict });
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
// Conflito pela chave NATURAL (product+supplier), não por client_id: um vínculo removido
// (só localmente) e re-adicionado ganha client_id novo; conflitar por client_id tentaria
// INSERT e violaria a unique (product, supplier). Pela chave natural o re-add vira UPDATE,
// dispara o trigger de histórico de preço e não quebra o sync.
async function pushProductSuppliers(): Promise<void> {
  // 1) Exclusões definitivas pendentes: propaga o delete pro servidor (por chave natural,
  //    robusto mesmo se o client_id divergiu) e só então apaga local. Isola por linha p/
  //    uma falha não travar as demais.
  const toDelete = await db
    .select()
    .from(productSuppliers)
    .where(eq(productSuppliers.pendingDelete, true));
  for (const r of toDelete) {
    await withRetry(async () => {
      const { error } = await supabase
        .from('product_suppliers')
        .delete()
        .eq('product_client_id', r.productId)
        .eq('supplier_client_id', r.supplierId);
      if (error) throw new Error(`[sync:product_suppliers delete] ${error.message}`);
    });
    await db.delete(productSuppliers).where(eq(productSuppliers.id, r.id));
  }

  // 2) Upsert dos vínculos ativos/editados (exclui os marcados p/ exclusão).
  const rows = await db
    .select()
    .from(productSuppliers)
    .where(and(eq(productSuppliers.needsSync, true), eq(productSuppliers.pendingDelete, false)));
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
        is_active: r.isActive,
      })),
      'product_client_id,supplier_client_id',
    ),
  );
  await db
    .update(productSuppliers)
    .set({ needsSync: false, syncedAt: Date.now() })
    .where(and(eq(productSuppliers.needsSync, true), eq(productSuppliers.pendingDelete, false)));
}

// Vendas + itens enviados UMA VENDA POR VEZ (item 2 — isolamento de falha):
// o upsert de sale_items é atômico por requisição, então uma venda com estoque
// insuficiente no servidor (que dispara o CHECK quantity >= 0 via trg_deduct_stock_on_sale)
// falha sozinha, sem contaminar as demais vendas pendentes.
// Retorna true se TODAS as vendas subiram; false se ao menos uma falhou (fica pendente p/ retry).
async function pushSalesWithItems(tenantId: string): Promise<boolean> {
  const saleRows = await db.select().from(sales).where(eq(sales.needsSync, true));
  if (saleRows.length === 0) return true;

  let allOk = true;
  for (const s of saleRows) {
    // Itens desta venda (mesmo que já sincronizados — o upsert é idempotente por client_id;
    // ON CONFLICT DO UPDATE não redispara o AFTER INSERT, então não há dupla dedução).
    const itemRows = await db.select().from(saleItems).where(eq(saleItems.saleId, s.id));
    try {
      // Pai primeiro (FK sale_client_id no servidor).
      await withRetry(() =>
        upsertRemote('sales', [
          {
            client_id: s.id,
            tenant_id: tenantId,
            sale_date: new Date(s.saleDate).toISOString(),
            total_amount: s.totalAmount,
            payment_method: s.paymentMethod,
            consumption_mode: s.consumptionMode,
          },
        ]),
      );
      if (itemRows.length > 0) {
        await withRetry(() =>
          upsertRemote(
            'sale_items',
            itemRows.map((r) => ({
              client_id: r.id,
              sale_client_id: r.saleId,
              product_client_id: r.productId,
              quantity: r.quantity,
              unit_price: r.unitPrice,
            })),
          ),
        );
      }
      const now = Date.now();
      await db.update(sales).set({ needsSync: false, syncedAt: now }).where(eq(sales.id, s.id));
      await db
        .update(saleItems)
        .set({ needsSync: false, syncedAt: now })
        .where(eq(saleItems.saleId, s.id));
    } catch (e) {
      console.warn('[sync] venda pendente (segue no próximo ciclo)', s.id, e);
      allOk = false;
    }
  }
  return allOk;
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

// Vínculos produto↔fornecedor: server-wins. Só o OWNER escreve (RBAC), então nos
// demais aparelhos isto é read-only e reconcilia inativações/edições/exclusões feitas
// pelo owner. Preserva edições LOCAIS pendentes (needsSync/pendingDelete) e apaga
// localmente os vínculos já sincronizados que sumiram do servidor (excluídos alhures).
async function pullProductSuppliers(): Promise<void> {
  const { data, error } = await supabase
    .from('product_suppliers')
    .select('client_id, product_client_id, supplier_client_id, purchase_price, is_preferred, is_active')
    .returns<RemoteProductSupplier[]>();
  if (error) throw new Error(`[sync:pull product_suppliers] ${error.message}`);
  if (!data) return;
  const now = Date.now();
  const serverIds = new Set(data.map((r) => r.client_id));

  for (const r of data) {
    // Não sobrescrever alteração local ainda não sincronizada.
    const local = await db
      .select()
      .from(productSuppliers)
      .where(eq(productSuppliers.id, r.client_id));
    if (local.length && (local[0].needsSync || local[0].pendingDelete)) continue;
    const set = {
      productId: r.product_client_id,
      supplierId: r.supplier_client_id,
      purchasePrice: r.purchase_price,
      isPreferred: r.is_preferred,
      isActive: r.is_active,
      pendingDelete: false,
      needsSync: false,
      syncedAt: now,
    };
    await db
      .insert(productSuppliers)
      .values({ id: r.client_id, ...set })
      .onConflictDoUpdate({ target: productSuppliers.id, set });
  }

  // Exclusões feitas em outro aparelho: some do servidor → apaga local (só linhas já
  // sincronizadas e sem alteração pendente, p/ não perder trabalho local).
  const localRows = await db.select().from(productSuppliers);
  for (const row of localRows) {
    if (!serverIds.has(row.id) && !row.needsSync && !row.pendingDelete) {
      await db.delete(productSuppliers).where(eq(productSuppliers.id, row.id));
    }
  }
}

// Histórico de preço: gerado pelo servidor (trigger em product_suppliers), pull-only —
// sem push. Sem tenant_id direto (normalizada); RLS filtra pelo produto pai.
async function pullProductSupplierPriceHistory(): Promise<void> {
  const { data, error } = await supabase
    .from('product_supplier_price_history')
    .select('client_id, product_client_id, supplier_client_id, purchase_price, is_preferred, recorded_at')
    .returns<RemotePriceHistory[]>();
  if (error) throw new Error(`[sync:pull product_supplier_price_history] ${error.message}`);
  if (!data) return;
  const now = Date.now();
  for (const r of data) {
    const set = {
      productId: r.product_client_id,
      supplierId: r.supplier_client_id,
      purchasePrice: r.purchase_price,
      isPreferred: r.is_preferred,
      recordedAt: new Date(r.recorded_at).getTime(),
      syncedAt: now,
    };
    await db
      .insert(productSupplierPriceHistory)
      .values({ id: r.client_id, ...set })
      .onConflictDoUpdate({ target: productSupplierPriceHistory.id, set });
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

// Sinaliza (por execução) que alguma etapa foi barrada pela RLS/permissão — para
// avisar o usuário em vez de deixar a falha silenciosa. Resetado no início de runSync.
let permissionDenied = false;

// Erro de permissão do Postgres/PostgREST: RLS (42501) ou "row-level security".
function isPermissionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /row-level security|permission denied|42501/i.test(msg);
}

// Executa uma etapa do sync isolando a falha (item 2): um erro numa etapa
// não impede as demais nem os pulls. Retorna true se a etapa passou.
// (Uma etapa que já sinaliza sucesso parcial retornando boolean é respeitada.)
async function runStep(label: string, fn: () => Promise<void | boolean>): Promise<boolean> {
  try {
    const res = await fn();
    return res !== false;
  } catch (e) {
    if (isPermissionError(e)) permissionDenied = true;
    console.warn(`[sync] etapa "${label}" falhou`, e);
    return false;
  }
}

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
  permissionDenied = false;
  const store = useSyncStore.getState();
  store.setStatus('syncing');
  try {
    // Ordem importa (FKs + triggers de estoque no servidor):
    // catálogo → associações → ENTRADAS de estoque (somam) → vendas/itens (deduzem)
    // → limite de estoque. As entradas vêm ANTES das vendas (item 1) para o servidor
    // creditar o saldo antes de deduzir e não estourar o CHECK quantity >= 0.
    // Só empurra o que o PAPEL pode escrever no servidor (espelho da RLS): o
    // funcionário (caixa) empurra apenas vendas/itens. Evita tentar pushes que a
    // RLS barraria — o que gerava warnings e o toast em pendências órfãs de catálogo.
    const role = useAuthStore.getState().currentRole;
    let ok = true;
    if (canWriteCatalog(role)) ok = (await runStep('products', () => pushProducts(tenantId))) && ok;
    if (canWriteSuppliers(role)) ok = (await runStep('suppliers', () => pushSuppliers(tenantId))) && ok;
    if (canWriteSuppliers(role)) ok = (await runStep('product_suppliers', () => pushProductSuppliers())) && ok;
    if (canWriteCatalog(role)) ok = (await runStep('stock_entries', () => pushStockEntries(tenantId))) && ok;
    ok = (await runStep('sales', () => pushSalesWithItems(tenantId))) && ok;
    if (canWriteCatalog(role)) ok = (await runStep('stock_thresholds', () => pushStockThresholds(tenantId))) && ok;
    // Pulls server-wins (depois dos pushes, para a quantidade já refletir as vendas/entradas).
    ok = (await runStep('pull categories', () => pullCategories(tenantId))) && ok;
    ok = (await runStep('pull products', () => pullProducts(tenantId))) && ok;
    ok = (await runStep('pull suppliers', () => pullSuppliers(tenantId))) && ok;
    ok = (await runStep('pull product_suppliers', () => pullProductSuppliers())) && ok;
    ok =
      (await runStep('pull product_supplier_price_history', () =>
        pullProductSupplierPriceHistory(),
      )) && ok;
    ok = (await runStep('pull stock_items', () => pullStockItems(tenantId))) && ok;

    if (ok) {
      store.markSynced();
    } else {
      store.setStatus('error');
      await refreshPendingCount();
      // Falha por permissão (papel sem acesso de escrita): avisa em vez de silenciar.
      if (permissionDenied) {
        showToast('Sem permissão para enviar algumas alterações. Fale com o dono ou gerente.');
      }
    }
  } finally {
    running = false;
  }
}
