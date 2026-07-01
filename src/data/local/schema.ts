import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Schema local (Drizzle + expo-sqlite) — Plano B.
// Campos de controle de sync em todos os modelos sincronizados:
//   id (= client_id / UUID, chave de idempotência), needs_sync, synced_at.

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
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
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const sales = sqliteTable('sales', {
  id: text('id').primaryKey(),
  saleDate: integer('sale_date').notNull(), // epoch ms
  totalAmount: real('total_amount').notNull(),
  paymentMethod: text('payment_method').notNull(),
  consumptionMode: text('consumption_mode').notNull(),
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
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const stockItems = sqliteTable('stock_items', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull().unique(),
  quantity: real('quantity').notNull().default(0),
  alertThreshold: real('alert_threshold').notNull().default(0),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const stockEntries = sqliteTable('stock_entries', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  quantity: real('quantity').notNull(),
  unitCost: real('unit_cost'),
  entryDate: integer('entry_date').notNull(), // epoch ms
  notes: text('notes'),
  needsSync: integer('needs_sync', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at'),
});

export const syncCheckpoints = sqliteTable('sync_checkpoints', {
  tableName: text('table_name').primaryKey(),
  lastSyncedAt: integer('last_synced_at').notNull().default(0),
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
