import { eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import {
  productSuppliers,
  suppliers,
  type ProductSupplierRow,
  type SupplierRow,
} from '@/data/local/schema';
import type { NewProductSupplier, ProductSupplier } from '@/domain/entities/ProductSupplier';
import type { Supplier } from '@/domain/entities/Supplier';
import type { SupplierRepository } from '@/domain/repositories/SupplierRepository';

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName ?? undefined,
    phone: row.phone ?? undefined,
    address: row.address ?? undefined,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

function toLink(row: ProductSupplierRow): ProductSupplier {
  return {
    id: row.id,
    productId: row.productId,
    supplierId: row.supplierId,
    purchasePrice: row.purchasePrice,
    isPreferred: row.isPreferred,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

/** Implementação do SupplierRepository sobre Drizzle + expo-sqlite (Plano B). */
export class DrizzleSupplierRepository implements SupplierRepository {
  async list(): Promise<Supplier[]> {
    const rows = await db.select().from(suppliers);
    return rows.map(toSupplier);
  }

  async getById(id: string): Promise<Supplier | null> {
    const rows = await db.select().from(suppliers).where(eq(suppliers.id, id));
    return rows.length ? toSupplier(rows[0]) : null;
  }

  async create(input: Omit<Supplier, 'id' | 'needsSync' | 'syncedAt'>): Promise<Supplier> {
    const id = Crypto.randomUUID();
    await db.insert(suppliers).values({
      id,
      name: input.name,
      contactName: input.contactName ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      needsSync: true,
    });
    return { id, ...input, needsSync: true };
  }

  async update(id: string, patch: Partial<Supplier>): Promise<void> {
    const set: Partial<SupplierPatch> = { needsSync: true };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.contactName !== undefined) set.contactName = patch.contactName ?? null;
    if (patch.phone !== undefined) set.phone = patch.phone ?? null;
    if (patch.address !== undefined) set.address = patch.address ?? null;
    await db.update(suppliers).set(set).where(eq(suppliers.id, id));
  }

  observeAll(onChange: (items: Supplier[]) => void): () => void {
    const emit = () => {
      this.list().then(onChange).catch(() => undefined);
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'suppliers') emit();
    });
    return () => subscription.remove();
  }

  async listLinks(supplierId: string): Promise<ProductSupplier[]> {
    const rows = await db
      .select()
      .from(productSuppliers)
      .where(eq(productSuppliers.supplierId, supplierId));
    return rows.map(toLink);
  }

  async addLink(input: NewProductSupplier): Promise<void> {
    await db.insert(productSuppliers).values({
      id: Crypto.randomUUID(),
      productId: input.productId,
      supplierId: input.supplierId,
      purchasePrice: input.purchasePrice,
      isPreferred: input.isPreferred ?? false,
      needsSync: true,
    });
  }

  async removeLink(id: string): Promise<void> {
    await db.delete(productSuppliers).where(eq(productSuppliers.id, id));
  }
}

type SupplierPatch = {
  name: string;
  contactName: string | null;
  phone: string | null;
  address: string | null;
  needsSync: boolean;
};
