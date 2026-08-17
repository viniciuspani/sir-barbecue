import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import * as schema from './schema';

// `enableChangeListener: true` habilita o addDatabaseChangeListener
// (reatividade — substitui os observables do WatermelonDB).
export const sqlite = openDatabaseSync('sirbarbecue.db', { enableChangeListener: true });

// Bootstrap do schema local (Fase 0/3/4) — criado diretamente.
// Quando o schema crescer (todas as tabelas — doc 02a), migrar para drizzle-kit + useMigrations.
sqlite.execSync(`
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    tenant_id TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    category_id TEXT,
    visible_days TEXT,
    tenant_id TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY NOT NULL,
    sale_date INTEGER NOT NULL,
    total_amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    consumption_mode TEXT NOT NULL,
    tenant_id TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY NOT NULL,
    sale_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    address TEXT,
    tenant_id TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS product_suppliers (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    purchase_price REAL NOT NULL,
    is_preferred INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    pending_delete INTEGER NOT NULL DEFAULT 0,
    tenant_id TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS product_supplier_price_history (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    purchase_price REAL NOT NULL,
    is_preferred INTEGER NOT NULL DEFAULT 0,
    recorded_at INTEGER NOT NULL,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS stock_items (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL UNIQUE,
    quantity REAL NOT NULL DEFAULT 0,
    alert_threshold REAL NOT NULL DEFAULT 0,
    tenant_id TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS stock_entries (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    entry_date INTEGER NOT NULL,
    notes TEXT,
    tenant_id TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sync_checkpoints (
    table_name TEXT PRIMARY KEY NOT NULL,
    last_synced_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY NOT NULL,
    customer_name TEXT NOT NULL,
    opened_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tab_items (
    id TEXT PRIMARY KEY NOT NULL,
    tab_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS error_logs (
    id TEXT PRIMARY KEY NOT NULL,
    ref_code TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    severity TEXT NOT NULL DEFAULT 'error',
    screen TEXT,
    action TEXT,
    context TEXT,
    message TEXT NOT NULL,
    detail TEXT,
    user_message TEXT,
    user_id TEXT,
    tenant_id TEXT,
    app_version TEXT,
    platform TEXT,
    os_version TEXT,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);
  CREATE INDEX IF NOT EXISTS idx_stock_entries_product ON stock_entries (product_id);
  CREATE INDEX IF NOT EXISTS idx_price_history_product ON product_supplier_price_history (product_id, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers (supplier_id);
  CREATE INDEX IF NOT EXISTS idx_products_needs_sync ON products (needs_sync);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
  CREATE INDEX IF NOT EXISTS idx_sales_needs_sync ON sales (needs_sync);
  CREATE INDEX IF NOT EXISTS idx_sale_items_needs_sync ON sale_items (needs_sync);
  CREATE INDEX IF NOT EXISTS idx_tab_items_tab ON tab_items (tab_id);
  CREATE INDEX IF NOT EXISTS idx_error_logs_needs_sync ON error_logs (needs_sync);
  CREATE INDEX IF NOT EXISTS idx_error_logs_occurred ON error_logs (occurred_at DESC);
`);

// Migração incremental para BDs já existentes (device com Fase 0–3):
// adiciona a coluna visible_days a products se ainda não existir.
const productCols = sqlite.getAllSync<{ name: string }>('PRAGMA table_info(products)');
if (!productCols.some((c) => c.name === 'visible_days')) {
  sqlite.execSync('ALTER TABLE products ADD COLUMN visible_days TEXT');
}

// Migração incremental: custo passou a ser centralizado no fornecedor
// (product_suppliers), removendo unit_cost de stock_entries em devices existentes.
const stockEntryCols = sqlite.getAllSync<{ name: string }>('PRAGMA table_info(stock_entries)');
if (stockEntryCols.some((c) => c.name === 'unit_cost')) {
  sqlite.execSync('ALTER TABLE stock_entries DROP COLUMN unit_cost');
}

// Migração incremental: inativação/exclusão de vínculo produto↔fornecedor.
// is_active (soft delete p/ troca de fornecedor) e pending_delete (marca de
// exclusão definitiva a propagar no sync) em devices existentes.
const productSupplierCols = sqlite.getAllSync<{ name: string }>(
  'PRAGMA table_info(product_suppliers)',
);
if (!productSupplierCols.some((c) => c.name === 'is_active')) {
  sqlite.execSync('ALTER TABLE product_suppliers ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
}
if (!productSupplierCols.some((c) => c.name === 'pending_delete')) {
  sqlite.execSync('ALTER TABLE product_suppliers ADD COLUMN pending_delete INTEGER NOT NULL DEFAULT 0');
}

// Migração incremental: isolamento por empresa. Carimba tenant_id nas tabelas
// sincronizáveis para que o dado local só suba sob a empresa ativa (trava de
// segurança contra adoção de dado órfão de outra conta no mesmo aparelho).
// Linhas legadas ficam com tenant_id NULL de propósito → NÃO sincronizam (o push
// exige tenant_id = empresa ativa), evitando readotar dados de origem desconhecida.
for (const table of ['categories', 'products', 'sales', 'suppliers', 'product_suppliers', 'stock_items', 'stock_entries']) {
  const cols = sqlite.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === 'tenant_id')) {
    sqlite.execSync(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT`);
  }
}

export const db = drizzle(sqlite, { schema });
