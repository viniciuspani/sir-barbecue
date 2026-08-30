import { and, eq, inArray } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { db } from '@/data/local/database';
import {
  categories,
  errorLogs,
  productSupplierPriceHistory,
  productSuppliers,
  products,
  saleItems,
  sales,
  stockEntries,
  stockItems,
  suppliers,
  syncCheckpoints,
  tabItems,
  tabs,
} from '@/data/local/schema';
import { supabase } from '@/data/remote/supabaseClient';
import type { ConsumptionMode, PaymentMethod } from '@/domain/entities/Sale';
import { isPermissionError } from '@/lib/errors';
import { logSilently } from '@/lib/feedback';
import { canWriteCatalog, canWriteSuppliers } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { useAuthStore } from '@/store/authStore';
import { useSyncStore } from '@/store/syncStore';

const MAX_ATTEMPTS = 3;
// Teto por ciclo: um aparelho que ficou dias offline não sobe o log inteiro de uma vez.
const ERROR_LOG_BATCH = 50;
// O sync repete a cada 5 min; registra a mesma falha no máximo 1x por hora.
const SYNC_LOG_DEDUPE_MS = 60 * 60 * 1000;

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
type RemoteProductDay = {
  product_client_id: string;
  day_of_week: number;
  is_visible: boolean;
};
type RemoteSale = {
  client_id: string;
  sale_date: string;
  total_amount: number;
  payment_method: PaymentMethod;
  consumption_mode: ConsumptionMode;
  updated_at: string;
};
type RemoteSaleItem = {
  client_id: string;
  sale_client_id: string;
  product_client_id: string;
  quantity: number;
  unit_price: number;
};
type RemoteTab = {
  client_id: string;
  customer_name: string;
  opened_at: string;
};
type RemoteTabItem = {
  client_id: string;
  tab_client_id: string;
  product_client_id: string;
  name: string;
  unit_price: number;
  quantity: number;
};
type RemoteStockItem = {
  product_client_id: string;
  quantity: number;
  alert_threshold: number;
};
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

// ISOLAMENTO POR EMPRESA: cada push filtra needs_sync AND tenant_id = empresa ativa.
// Assim, linha de outra empresa (ou órfã com tenant_id NULL, criada por conta sem
// vínculo) NUNCA sobe sob a conta atual. O UPDATE que limpa needs_sync usa o MESMO
// filtro, para não marcar como sincronizada uma linha de outra empresa.
async function pushProducts(tenantId: string): Promise<void> {
  const scope = and(eq(products.needsSync, true), eq(products.tenantId, tenantId));
  const rows = await db.select().from(products).where(scope);
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
  // Dias de visibilidade: filhos do produto, então só DEPOIS do upsert do pai.
  for (const r of rows) {
    await pushProductDays(r.id, r.visibleDays);
  }
  await db.update(products).set({ needsSync: false, syncedAt: Date.now() }).where(scope);
}

// visible_days é guardado local como JSON de números (0..6); no servidor é a
// tabela normalizada product_day_visibility (uma linha por dia visível).
function parseDays(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return []; // valor corrompido → trata como "todos os dias"
  }
}

/**
 * Dias de visibilidade (RF-05) do produto → servidor.
 *
 * Este dado NUNCA subia: ficava só no SQLite do aparelho, e a tabela
 * product_day_visibility permanecia vazia. Com dois clientes lendo o mesmo
 * banco, um produto de sexta-feira aparecia todos os dias no outro aparelho.
 *
 * Regrava por produto (apaga e insere): "nenhum dia" significa visível sempre,
 * então a ausência de linhas é um estado válido — não dá para representar isso
 * só com upsert. Roda por produto para uma falha não travar os demais.
 */
async function pushProductDays(productId: string, visibleDays: string | null): Promise<void> {
  await withRetry(async () => {
    const { error } = await supabase
      .from('product_day_visibility')
      .delete()
      .eq('product_client_id', productId);
    if (error) throw new Error(`[sync:product_day_visibility delete] ${error.message}`);
  });
  const days = parseDays(visibleDays);
  if (days.length === 0) return;
  await withRetry(() =>
    upsertRemote(
      'product_day_visibility',
      days.map((day) => ({
        client_id: Crypto.randomUUID(),
        product_client_id: productId,
        day_of_week: day,
        is_visible: true,
      })),
      'product_client_id,day_of_week',
    ),
  );
}

async function pushSuppliers(tenantId: string): Promise<void> {
  const scope = and(eq(suppliers.needsSync, true), eq(suppliers.tenantId, tenantId));
  const rows = await db.select().from(suppliers).where(scope);
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
  await db.update(suppliers).set({ needsSync: false, syncedAt: Date.now() }).where(scope);
}

// Associação N:N (normalizada): sem tenant_id; FK por product/supplier (devem já ter subido).
// Conflito pela chave NATURAL (product+supplier), não por client_id: um vínculo removido
// (só localmente) e re-adicionado ganha client_id novo; conflitar por client_id tentaria
// INSERT e violaria a unique (product, supplier). Pela chave natural o re-add vira UPDATE,
// dispara o trigger de histórico de preço e não quebra o sync.
async function pushProductSuppliers(tenantId: string): Promise<void> {
  // 1) Exclusões definitivas pendentes: propaga o delete pro servidor (por chave natural,
  //    robusto mesmo se o client_id divergiu) e só então apaga local. Isola por linha p/
  //    uma falha não travar as demais. Escopado por empresa ativa (isolamento).
  const toDelete = await db
    .select()
    .from(productSuppliers)
    .where(and(eq(productSuppliers.pendingDelete, true), eq(productSuppliers.tenantId, tenantId)));
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
  const scope = and(
    eq(productSuppliers.needsSync, true),
    eq(productSuppliers.pendingDelete, false),
    eq(productSuppliers.tenantId, tenantId),
  );
  const rows = await db.select().from(productSuppliers).where(scope);
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
  await db.update(productSuppliers).set({ needsSync: false, syncedAt: Date.now() }).where(scope);
}

// Vendas + itens enviados UMA VENDA POR VEZ (item 2 — isolamento de falha):
// o upsert de sale_items é atômico por requisição, então uma venda com estoque
// insuficiente no servidor (que dispara o CHECK quantity >= 0 via trg_deduct_stock_on_sale)
// falha sozinha, sem contaminar as demais vendas pendentes.
// Retorna true se TODAS as vendas subiram; false se ao menos uma falhou (fica pendente p/ retry).
async function pushSalesWithItems(tenantId: string): Promise<boolean> {
  // Só vendas da empresa ativa (isolamento): venda órfã (tenant_id NULL, de conta sem
  // vínculo) ou de outra empresa nunca sobe sob a conta atual.
  const saleRows = await db
    .select()
    .from(sales)
    .where(and(eq(sales.needsSync, true), eq(sales.tenantId, tenantId)));
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
      logSilently(e, {
        action: 'Enviar venda para o servidor',
        screen: 'sync',
        meta: { saleId: s.id },
        dedupeMs: SYNC_LOG_DEDUPE_MS,
      });
      allOk = false;
    }
  }
  return allOk;
}

// Estoque: o servidor RECALCULA a quantidade (triggers increment_stock_on_entry /
// deduct_stock_on_sale). O app envia apenas as ENTRADAS (não a quantidade do stock_items).
async function pushStockEntries(tenantId: string): Promise<void> {
  const scope = and(eq(stockEntries.needsSync, true), eq(stockEntries.tenantId, tenantId));
  const rows = await db.select().from(stockEntries).where(scope);
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
  await db.update(stockEntries).set({ needsSync: false, syncedAt: Date.now() }).where(scope);
}

// alert_threshold é CONFIG do cliente → atualiza o stock_items no servidor por product_client_id
// (a linha é criada pela entrada). A quantidade é server-owned (reconciliada no pull).
async function pushStockThresholds(tenantId: string): Promise<void> {
  const scope = and(eq(stockItems.needsSync, true), eq(stockItems.tenantId, tenantId));
  const rows = await db.select().from(stockItems).where(scope);
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
  await db.update(stockItems).set({ needsSync: false }).where(scope);
}

// Log de erros: sobe para consulta no painel do dono.
//
// Duas diferenças propositais em relação às demais etapas:
//  1) NÃO filtra por tenant na origem. Um erro pode ter sido gravado antes do
//     login ou sem vínculo com empresa (justamente os casos mais críticos de
//     diagnosticar) — esses sobem carimbados com a empresa/usuário ativos agora,
//     e o `context` já marca preAuth: true para o suporte saber disso.
//  2) Roda para TODOS os papéis: qualquer usuário registra o próprio erro
//     (a RLS do servidor exige user_id = auth.uid()).
async function pushErrorLogs(tenantId: string, userId: string): Promise<void> {
  const rows = await db
    .select()
    .from(errorLogs)
    .where(eq(errorLogs.needsSync, true))
    .orderBy(errorLogs.occurredAt)
    .limit(ERROR_LOG_BATCH);
  if (rows.length === 0) return;

  await withRetry(() =>
    upsertRemote(
      'error_logs',
      rows.map((r) => ({
        client_id: r.id,
        tenant_id: r.tenantId ?? tenantId,
        user_id: r.userId ?? userId,
        ref_code: r.refCode,
        occurred_at: new Date(r.occurredAt).toISOString(),
        severity: r.severity,
        screen: r.screen,
        action: r.action,
        message: r.message,
        detail: r.detail,
        user_message: r.userMessage,
        context: r.context ? safeParseJson(r.context) : null,
        app_version: r.appVersion,
        platform: r.platform,
        os_version: r.osVersion,
      })),
    ),
  );

  const now = Date.now();
  await db
    .update(errorLogs)
    .set({ needsSync: false, syncedAt: now, tenantId, userId })
    .where(
      inArray(
        errorLogs.id,
        rows.map((r) => r.id),
      ),
    );
}

// context é jsonb no servidor: envia objeto, não string. Se o JSON estiver
// corrompido, sobe como null — o log nunca deve travar por causa do contexto.
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Comandas: sobe comandas e itens; propaga fechamentos e remoções de item.
 *
 * A comanda é atendimento EM ANDAMENTO, então a ordem aqui importa:
 *  1. comandas (o item tem FK para a comanda no servidor — subir item antes
 *     de a comanda existir falharia);
 *  2. itens removidos (delete), antes dos upserts, para não reviver linha;
 *  3. itens vivos (upsert pela chave natural comanda+produto, igual ao app,
 *     que mantém UMA linha por produto).
 *
 * Depois de propagada, a comanda fechada é APAGADA do banco local: ela já virou
 * venda (ou foi descartada) e só ocuparia espaço no aparelho do PDV.
 */
async function pushTabs(tenantId: string): Promise<void> {
  const tabScope = and(eq(tabs.needsSync, true), eq(tabs.tenantId, tenantId));
  const tabRows = await db.select().from(tabs).where(tabScope);

  if (tabRows.length > 0) {
    await withRetry(() =>
      upsertRemote(
        'tabs',
        tabRows.map((t) => ({
          client_id: t.id,
          tenant_id: tenantId,
          customer_name: t.customerName,
          status: t.status,
          opened_at: new Date(t.openedAt).toISOString(),
          closed_at: t.closedAt ? new Date(t.closedAt).toISOString() : null,
        })),
      ),
    );
    await db.update(tabs).set({ needsSync: false, syncedAt: Date.now() }).where(tabScope);
  }

  // ISOLAMENTO: tab_items não tem tenant_id (o dono é a comanda). Restringir aos
  // itens das comandas DESTA empresa evita que uma linha órfã ou de outra conta
  // no mesmo aparelho suba sob a sessão atual — mesma regra dos demais pushes.
  const tenantTabIds = (
    await db.select({ id: tabs.id }).from(tabs).where(eq(tabs.tenantId, tenantId))
  ).map((t) => t.id);
  if (tenantTabIds.length === 0) return;

  // Itens removidos da comanda: apaga no servidor e só então some daqui.
  const toDelete = await db
    .select()
    .from(tabItems)
    .where(and(eq(tabItems.pendingDelete, true), inArray(tabItems.tabId, tenantTabIds)));
  for (const item of toDelete) {
    await withRetry(async () => {
      const { error } = await supabase
        .from('tab_items')
        .delete()
        .eq('tab_client_id', item.tabId)
        .eq('product_client_id', item.productId);
      if (error) throw new Error(`[sync:tab_items delete] ${error.message}`);
    });
    await db.delete(tabItems).where(eq(tabItems.id, item.id));
  }

  const itemScope = and(
    eq(tabItems.needsSync, true),
    eq(tabItems.pendingDelete, false),
    inArray(tabItems.tabId, tenantTabIds),
  );
  const itemRows = await db.select().from(tabItems).where(itemScope);
  if (itemRows.length > 0) {
    await withRetry(() =>
      upsertRemote(
        'tab_items',
        itemRows.map((i) => ({
          client_id: i.id,
          tab_client_id: i.tabId,
          product_client_id: i.productId,
          name: i.name,
          unit_price: i.unitPrice,
          quantity: i.quantity,
        })),
        'tab_client_id,product_client_id',
      ),
    );
    await db.update(tabItems).set({ needsSync: false, syncedAt: Date.now() }).where(itemScope);
  }

  // Faxina: comanda fechada e já sincronizada não precisa mais existir local.
  const closed = await db
    .select()
    .from(tabs)
    .where(and(eq(tabs.status, 'closed'), eq(tabs.needsSync, false), eq(tabs.tenantId, tenantId)));
  for (const t of closed) {
    await db.delete(tabItems).where(eq(tabItems.tabId, t.id));
    await db.delete(tabs).where(eq(tabs.id, t.id));
  }
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
      .values({ id: r.client_id, name: r.name, tenantId, needsSync: false, syncedAt: now })
      .onConflictDoUpdate({
        target: categories.id,
        set: { name: r.name, tenantId, needsSync: false, syncedAt: now },
      });
  }
}

// Catálogo: server-wins (doc 01c §10.3). Filtra pela empresa ativa.
/**
 * Produtos + dias de visibilidade do servidor.
 *
 * Linha com alteração local pendente é PULADA: o push roda antes, mas pode ter
 * falhado (offline, permissão). Sobrescrevê-la aqui — e ainda limpar
 * `needs_sync` — descartaria em silêncio a edição que o usuário fez no aparelho.
 */
async function pullProducts(tenantId: string): Promise<void> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('tenant_id', tenantId)
    .returns<RemoteProduct[]>();
  if (error) throw new Error(`[sync:pull products] ${error.message}`);
  if (!data) return;

  // Dias visíveis de todos os produtos desta empresa, em uma consulta só.
  const ids = data.map((r) => r.client_id);
  const daysByProduct = new Map<string, number[]>();
  if (ids.length > 0) {
    const { data: dayData, error: dayError } = await supabase
      .from('product_day_visibility')
      .select('product_client_id, day_of_week, is_visible')
      .in('product_client_id', ids)
      .returns<RemoteProductDay[]>();
    if (dayError) throw new Error(`[sync:pull product_day_visibility] ${dayError.message}`);
    for (const d of dayData ?? []) {
      if (!d.is_visible) continue;
      const list = daysByProduct.get(d.product_client_id) ?? [];
      list.push(d.day_of_week);
      daysByProduct.set(d.product_client_id, list);
    }
  }

  const now = Date.now();
  for (const r of data) {
    const days = daysByProduct.get(r.client_id) ?? [];
    // Vazio = todos os dias; guardamos NULL para manter o formato local.
    const visibleDays = days.length > 0 ? JSON.stringify(days.sort((a, b) => a - b)) : null;
    const existing = await db.select().from(products).where(eq(products.id, r.client_id));
    if (existing.length) {
      if (existing[0].needsSync) continue; // edição local ainda não enviada
      await db
        .update(products)
        .set({
          name: r.name,
          price: r.price,
          isActive: r.is_active,
          categoryId: r.category_client_id ?? null,
          visibleDays,
          tenantId,
          needsSync: false,
          syncedAt: now,
        })
        .where(eq(products.id, r.client_id));
    } else {
      await db.insert(products).values({
        id: r.client_id,
        name: r.name,
        price: r.price,
        isActive: r.is_active,
        categoryId: r.category_client_id ?? null,
        visibleDays,
        tenantId,
        needsSync: false,
        syncedAt: now,
      });
    }
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
      tenantId,
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
/**
 * Puxa saldo E limite de alerta.
 *
 * O `alert_threshold` faltava aqui: o app ENVIA o limite (pushStockThresholds)
 * mas nunca o trazia de volta, então um limite configurado em OUTRO cliente (o
 * app web) jamais chegava ao aparelho — o alerta de estoque baixo divergia entre
 * as plataformas.
 *
 * Cuidado com a linha que tem alteração local pendente (`needs_sync`): o push
 * roda antes do pull, mas pode ter falhado (sem rede, permissão). Nesse caso o
 * saldo do servidor é aplicado — ele é a fonte da verdade, calculado por trigger
 * —, mas o limite local é PRESERVADO e a linha continua marcada, para o próximo
 * ciclo enviá-la. Sem isso, o pull apagaria a marca e a alteração do usuário
 * sumiria em silêncio.
 */
async function pullStockItems(tenantId: string): Promise<void> {
  const { data, error } = await supabase
    .from('stock_items')
    .select('product_client_id, quantity, alert_threshold')
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
      const pending = existing[0].needsSync;
      await db
        .update(stockItems)
        .set({
          quantity: r.quantity,
          alertThreshold: pending ? existing[0].alertThreshold : r.alert_threshold,
          tenantId,
          needsSync: pending,
          syncedAt: now,
        })
        .where(eq(stockItems.productId, r.product_client_id));
    } else {
      await db.insert(stockItems).values({
        id: Crypto.randomUUID(),
        productId: r.product_client_id,
        quantity: r.quantity,
        alertThreshold: r.alert_threshold,
        tenantId,
        needsSync: false,
        syncedAt: now,
      });
    }
  }
}

/**
 * Comandas ABERTAS do servidor → local (server-wins).
 *
 * Linha com alteração local pendente é PULADA: o push roda antes, mas pode ter
 * falhado (offline) — sobrescrevê-la aqui apagaria o pedido que o atendente
 * acabou de lançar. Comanda que sumiu da lista de abertas (fechada em outro
 * aparelho) é removida daqui, junto com os itens.
 */
async function pullTabs(tenantId: string): Promise<void> {
  const { data, error } = await supabase
    .from('tabs')
    .select('client_id, customer_name, opened_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .returns<RemoteTab[]>();
  if (error) throw new Error(`[sync:pull tabs] ${error.message}`);
  if (!data) return;
  const now = Date.now();
  const openIds = data.map((t) => t.client_id);

  for (const r of data) {
    const existing = await db.select().from(tabs).where(eq(tabs.id, r.client_id));
    if (existing.length) {
      if (existing[0].needsSync) continue; // alteração local ainda não enviada
      await db
        .update(tabs)
        .set({
          customerName: r.customer_name,
          status: 'open',
          tenantId,
          needsSync: false,
          syncedAt: now,
        })
        .where(eq(tabs.id, r.client_id));
    } else {
      await db.insert(tabs).values({
        id: r.client_id,
        customerName: r.customer_name,
        openedAt: new Date(r.opened_at).getTime(),
        status: 'open',
        tenantId,
        needsSync: false,
        syncedAt: now,
      });
    }
  }

  // Itens das comandas abertas.
  if (openIds.length > 0) {
    const { data: itemData, error: itemError } = await supabase
      .from('tab_items')
      .select('client_id, tab_client_id, product_client_id, name, unit_price, quantity')
      .in('tab_client_id', openIds)
      .returns<RemoteTabItem[]>();
    if (itemError) throw new Error(`[sync:pull tab_items] ${itemError.message}`);

    for (const r of itemData ?? []) {
      const existing = await db.select().from(tabItems).where(eq(tabItems.id, r.client_id));
      if (existing.length) {
        if (existing[0].needsSync || existing[0].pendingDelete) continue;
        await db
          .update(tabItems)
          .set({ quantity: r.quantity, needsSync: false, syncedAt: now })
          .where(eq(tabItems.id, r.client_id));
      } else {
        await db.insert(tabItems).values({
          id: r.client_id,
          tabId: r.tab_client_id,
          productId: r.product_client_id,
          name: r.name,
          unitPrice: r.unit_price,
          quantity: r.quantity,
          needsSync: false,
          syncedAt: now,
        });
      }
    }
  }

  // Comandas que deixaram de estar abertas no servidor saem do aparelho —
  // exceto as que têm alteração local pendente (ainda não subiram).
  const localOpen = await db
    .select()
    .from(tabs)
    .where(and(eq(tabs.status, 'open'), eq(tabs.tenantId, tenantId), eq(tabs.needsSync, false)));
  for (const t of localOpen) {
    if (openIds.includes(t.id)) continue;
    await db.delete(tabItems).where(eq(tabItems.tabId, t.id));
    await db.delete(tabs).where(eq(tabs.id, t.id));
  }
}

// Janela do primeiro pull de vendas: um aparelho novo (ou recém-atualizado) não
// pode baixar o histórico inteiro da empresa de uma vez. 90 dias cobrem com folga
// a Home (hoje) e os Relatórios (até o mês).
const SALES_FIRST_PULL_DAYS = 90;
// Teto por ciclo — o restante vem no próximo, avançando o checkpoint.
const SALES_PULL_LIMIT = 500;

async function readCheckpoint(table: string): Promise<number> {
  const rows = await db
    .select()
    .from(syncCheckpoints)
    .where(eq(syncCheckpoints.tableName, table));
  return rows.length ? rows[0].lastSyncedAt : 0;
}

async function writeCheckpoint(table: string, value: number): Promise<void> {
  await db
    .insert(syncCheckpoints)
    .values({ tableName: table, lastSyncedAt: value })
    .onConflictDoUpdate({ target: syncCheckpoints.tableName, set: { lastSyncedAt: value } });
}

/**
 * Vendas do servidor → local (INCREMENTAL).
 *
 * Vendas eram push-only: subiam do aparelho e nunca voltavam. Com o PWA
 * registrando vendas direto no servidor, a Home e os Relatórios do app ficavam
 * sem enxergá-las — o dono via faturamento diferente em cada aparelho.
 *
 * O pull é incremental por `updated_at` (checkpoint em sync_checkpoints, tabela
 * que já existia no schema e não era usada). Sem isso, um PDV com meses de
 * operação baixaria o histórico inteiro a cada 5 minutos.
 */
async function pullSales(tenantId: string): Promise<void> {
  const checkpoint = await readCheckpoint('sales');
  const since =
    checkpoint > 0
      ? new Date(checkpoint)
      : new Date(Date.now() - SALES_FIRST_PULL_DAYS * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('sales')
    .select('client_id, sale_date, total_amount, payment_method, consumption_mode, updated_at')
    .eq('tenant_id', tenantId)
    .gt('updated_at', since.toISOString())
    .order('updated_at', { ascending: true })
    .limit(SALES_PULL_LIMIT)
    .returns<RemoteSale[]>();
  if (error) throw new Error(`[sync:pull sales] ${error.message}`);
  if (!data || data.length === 0) return;

  const now = Date.now();
  const pulledIds: string[] = [];
  for (const r of data) {
    const existing = await db.select().from(sales).where(eq(sales.id, r.client_id));
    if (existing.length) {
      // Venda com push pendente é do próprio aparelho e ainda não subiu: não mexer.
      if (existing[0].needsSync) continue;
      pulledIds.push(r.client_id);
      continue; // venda é imutável depois de registrada — nada a atualizar
    }
    await db.insert(sales).values({
      id: r.client_id,
      saleDate: new Date(r.sale_date).getTime(),
      totalAmount: r.total_amount,
      paymentMethod: r.payment_method,
      consumptionMode: r.consumption_mode,
      tenantId,
      needsSync: false,
      syncedAt: now,
    });
    pulledIds.push(r.client_id);
  }

  // Itens das vendas que chegaram agora (sem eles o relatório por produto fica vazio).
  if (pulledIds.length > 0) {
    const { data: itemData, error: itemError } = await supabase
      .from('sale_items')
      .select('client_id, sale_client_id, product_client_id, quantity, unit_price')
      .in('sale_client_id', pulledIds)
      .returns<RemoteSaleItem[]>();
    if (itemError) throw new Error(`[sync:pull sale_items] ${itemError.message}`);
    for (const r of itemData ?? []) {
      await db
        .insert(saleItems)
        .values({
          id: r.client_id,
          saleId: r.sale_client_id,
          productId: r.product_client_id,
          quantity: r.quantity,
          unitPrice: r.unit_price,
          needsSync: false,
          syncedAt: now,
        })
        .onConflictDoNothing();
    }
  }

  // Avança o checkpoint até a venda mais recente que chegou. Se o lote bateu no
  // teto, o próximo ciclo continua daqui.
  const lastUpdatedAt = new Date(data[data.length - 1].updated_at).getTime();
  await writeCheckpoint('sales', lastUpdatedAt);
}

// ---- Orquestração ------------------------------------------------------------

// Evita que uma atualização de comandas em tempo real e o ciclo completo mexam
// nas mesmas tabelas ao mesmo tempo.
let tabsSyncing = false;

/**
 * Sincroniza SÓ as comandas, na hora. Chamado pelo tempo real (tabsLive).
 *
 * Sobe o que estiver pendente antes de puxar: se o atendente lançou um item e a
 * notificação de outro aparelho chegou em seguida, o pull não pode passar por
 * cima do que ainda não subiu.
 */
export async function syncTabsNow(): Promise<void> {
  if (tabsSyncing || running) return;
  const tenantId = useAuthStore.getState().currentTenantId;
  if (!tenantId) return;
  const { data } = await supabase.auth.getSession();
  if (!data.session) return;

  tabsSyncing = true;
  try {
    await pushTabs(tenantId);
    await pullTabs(tenantId);
  } finally {
    tabsSyncing = false;
  }
}

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

// Executa uma etapa do sync isolando a falha (item 2): um erro numa etapa
// não impede as demais nem os pulls. Retorna true se a etapa passou.
// (Uma etapa que já sinaliza sucesso parcial retornando boolean é respeitada.)
async function runStep(label: string, fn: () => Promise<void | boolean>): Promise<boolean> {
  try {
    const res = await fn();
    return res !== false;
  } catch (e) {
    if (isPermissionError(e)) permissionDenied = true;
    // Sync é rotina de fundo: registra sem interromper o atendimento. Janela de
    // deduplicação longa porque o ciclo se repete a cada 5 min — um servidor com
    // problema geraria centenas de linhas idênticas por dia.
    logSilently(e, {
      action: `Sincronizar dados (${label})`,
      screen: 'sync',
      dedupeMs: SYNC_LOG_DEDUPE_MS,
    });
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
    if (canWriteSuppliers(role)) ok = (await runStep('product_suppliers', () => pushProductSuppliers(tenantId))) && ok;
    if (canWriteCatalog(role)) ok = (await runStep('stock_entries', () => pushStockEntries(tenantId))) && ok;
    ok = (await runStep('sales', () => pushSalesWithItems(tenantId))) && ok;
    // Comandas: atendimento em andamento — todo membro opera, como as vendas.
    ok = (await runStep('tabs', () => pushTabs(tenantId))) && ok;
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
    ok = (await runStep('pull tabs', () => pullTabs(tenantId))) && ok;
    // Vendas: traz também as registradas pelo app web, senão a Home e os
    // Relatórios do celular mostram um faturamento menor do que o real.
    ok = (await runStep('pull sales', () => pullSales(tenantId))) && ok;

    // Log de erros por ÚLTIMO e FORA do `ok`: é diagnóstico, não dado de negócio.
    // Se o envio do log falhar, o sync não pode ser marcado como erro (senão um
    // problema no log viraria alarme falso no PDV). E a falha NÃO gera novo log —
    // seria um erro sobre o erro, realimentando a fila indefinidamente.
    try {
      // user_id vem da SESSÃO (não do store): a RLS do servidor exige
      // user_id = auth.uid(), e o store pode estar um passo atrás numa troca de conta.
      await pushErrorLogs(tenantId, data.session.user.id);
    } catch (e) {
      console.warn('[sync] envio do log de erros adiado', e);
    }

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
