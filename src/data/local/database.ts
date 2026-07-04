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
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY NOT NULL,
    sale_date INTEGER NOT NULL,
    total_amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    consumption_mode TEXT NOT NULL,
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
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS product_suppliers (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    purchase_price REAL NOT NULL,
    is_preferred INTEGER NOT NULL DEFAULT 0,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS stock_items (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL UNIQUE,
    quantity REAL NOT NULL DEFAULT 0,
    alert_threshold REAL NOT NULL DEFAULT 0,
    needs_sync INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS stock_entries (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_cost REAL,
    entry_date INTEGER NOT NULL,
    notes TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);
  CREATE INDEX IF NOT EXISTS idx_stock_entries_product ON stock_entries (product_id);
  CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers (supplier_id);
  CREATE INDEX IF NOT EXISTS idx_products_needs_sync ON products (needs_sync);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
  CREATE INDEX IF NOT EXISTS idx_sales_needs_sync ON sales (needs_sync);
  CREATE INDEX IF NOT EXISTS idx_sale_items_needs_sync ON sale_items (needs_sync);
  CREATE INDEX IF NOT EXISTS idx_tab_items_tab ON tab_items (tab_id);
`);

// Migração incremental para BDs já existentes (device com Fase 0–3):
// adiciona a coluna visible_days a products se ainda não existir.
const productCols = sqlite.getAllSync<{ name: string }>('PRAGMA table_info(products)');
if (!productCols.some((c) => c.name === 'visible_days')) {
  sqlite.execSync('ALTER TABLE products ADD COLUMN visible_days TEXT');
}

export const db = drizzle(sqlite, { schema });
