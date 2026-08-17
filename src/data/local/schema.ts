import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Schema local (Drizzle + expo-sqlite) — Plano B.
// Campos de controle de sync em todos os modelos sincronizados:
//   id (= client_id / UUID, chave de idempotência), needs_sync, synced_at.

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tenantId: text('tenant_id'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  price: real('price').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  categoryId: text('category_id'),
  // JSON de números 0..6 (dom..sáb). null/[] = visível em todos os dias (RF-05).
  visibleDays: text('visible_days'),
  // Empresa dona da linha (carimbo local). Só sincroniza sob a empresa ativa (isolamento).
  tenantId: text('tenant_id'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const sales = sqliteTable('sales', {
  id: text('id').primaryKey(),
  saleDate: integer('sale_date').notNull(), // epoch ms
  totalAmount: real('total_amount').notNull(),
  paymentMethod: text('payment_method').notNull(),
  consumptionMode: text('consumption_mode').notNull(),
  tenantId: text('tenant_id'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const saleItems = sqliteTable('sale_items', {
  id: text('id').primaryKey(),
  saleId: text('sale_id').notNull(), // -> sales.id (client_id)
  productId: text('product_id').notNull(),
  quantity: integer('quantity').notNull(),
  unitPrice: real('unit_price').notNull(),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const suppliers = sqliteTable('suppliers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  contactName: text('contact_name'),
  phone: text('phone'),
  address: text('address'),
  tenantId: text('tenant_id'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

// Associação N:N produto↔fornecedor com preço de compra (RF-07).
export const productSuppliers = sqliteTable('product_suppliers', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  supplierId: text('supplier_id').notNull(),
  purchasePrice: real('purchase_price').notNull(),
  isPreferred: integer('is_preferred', { mode: 'boolean' }).notNull().default(false),
  // Inativo = trocou de fornecedor: some das telas de uso e do custo, fica no histórico.
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  // Marcado para exclusão definitiva: escondido da UI; o sync apaga no servidor e depois local.
  pendingDelete: integer('pending_delete', { mode: 'boolean' }).notNull().default(false),
  tenantId: text('tenant_id'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

// Histórico de preço de compra — somente leitura, alimentado pelo pull do
// sync engine (server-generated via trigger). Sem needsSync: o app nunca
// escreve aqui.
export const productSupplierPriceHistory = sqliteTable('product_supplier_price_history', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  supplierId: text('supplier_id').notNull(),
  purchasePrice: real('purchase_price').notNull(),
  isPreferred: integer('is_preferred', { mode: 'boolean' }).notNull().default(false),
  recordedAt: integer('recorded_at').notNull(), // epoch ms
  syncedAt: integer('synced_at'),
});

export const stockItems = sqliteTable('stock_items', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull().unique(),
  quantity: real('quantity').notNull().default(0),
  alertThreshold: real('alert_threshold').notNull().default(0),
  tenantId: text('tenant_id'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const stockEntries = sqliteTable('stock_entries', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  quantity: real('quantity').notNull(),
  entryDate: integer('entry_date').notNull(), // epoch ms
  notes: text('notes'),
  tenantId: text('tenant_id'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const syncCheckpoints = sqliteTable('sync_checkpoints', {
  tableName: text('table_name').primaryKey(),
  lastSyncedAt: integer('last_synced_at').notNull().default(0),
});

// Comandas (tabs) — estado de trabalho LOCAL, identificado pelo nome do cliente.
// Não é sincronizado: uma comanda só vira `sales`/`sale_items` no momento do pagamento.
export const tabs = sqliteTable('tabs', {
  id: text('id').primaryKey(),
  customerName: text('customer_name').notNull(),
  openedAt: integer('opened_at').notNull(), // epoch ms
});

// Itens vinculados à comanda. Denormaliza name/unit_price (como o carrinho) para render sem join.
export const tabItems = sqliteTable('tab_items', {
  id: text('id').primaryKey(),
  tabId: text('tab_id').notNull(), // -> tabs.id
  productId: text('product_id').notNull(),
  name: text('name').notNull(),
  unitPrice: real('unit_price').notNull(),
  quantity: integer('quantity').notNull(),
});

// Log de erros — grava LOCAL primeiro (o erro mais importante é o que acontece
// offline) e sobe para o servidor pelo sync. tenantId/userId são NULLABLE de
// propósito: um erro pode ocorrer antes do login ou sem vínculo com empresa.
export const errorLogs = sqliteTable('error_logs', {
  id: text('id').primaryKey(),
  // Código curto mostrado ao usuário no alerta; localiza este registro no log.
  refCode: text('ref_code').notNull(),
  occurredAt: integer('occurred_at').notNull(), // epoch ms
  severity: text('severity').notNull().default('error'), // 'error' | 'fatal'
  screen: text('screen'), // rota no momento do erro (ex.: /venda/fechar)
  action: text('action'), // o que o usuário estava fazendo (ex.: Fechar venda)
  // JSON: últimos passos (breadcrumbs), conectividade, papel, metadados da tela.
  context: text('context'),
  message: text('message').notNull(),
  // Mensagem COMPLETA: stack + code/details/hint do Postgres/Supabase.
  detail: text('detail'),
  userMessage: text('user_message'),
  userId: text('user_id'),
  tenantId: text('tenant_id'),
  appVersion: text('app_version'),
  platform: text('platform'),
  osVersion: text('os_version'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export type CategoryRow = typeof categories.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
export type SaleRow = typeof sales.$inferSelect;
export type NewSaleRow = typeof sales.$inferInsert;
export type SaleItemRow = typeof saleItems.$inferSelect;
export type NewSaleItemRow = typeof saleItems.$inferInsert;
export type StockItemRow = typeof stockItems.$inferSelect;
export type StockEntryRow = typeof stockEntries.$inferSelect;
export type SupplierRow = typeof suppliers.$inferSelect;
export type ProductSupplierRow = typeof productSuppliers.$inferSelect;
export type ProductSupplierPriceHistoryRow = typeof productSupplierPriceHistory.$inferSelect;
export type TabRow = typeof tabs.$inferSelect;
export type TabItemRow = typeof tabItems.$inferSelect;
export type ErrorLogRow = typeof errorLogs.$inferSelect;
export type NewErrorLogRow = typeof errorLogs.$inferInsert;
