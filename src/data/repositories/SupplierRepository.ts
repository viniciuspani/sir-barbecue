import { and, desc, eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import {
  productSupplierPriceHistory,
  productSuppliers,
  suppliers,
  type ProductSupplierPriceHistoryRow,
  type ProductSupplierRow,
  type SupplierRow,
} from '@/data/local/schema';
import type { NewProductSupplier, ProductSupplier } from '@/domain/entities/ProductSupplier';
import type { ProductSupplierPriceHistory } from '@/domain/entities/ProductSupplierPriceHistory';
import type { Supplier } from '@/domain/entities/Supplier';
import type { SupplierRepository } from '@/domain/repositories/SupplierRepository';
import { getActiveTenantId, getActiveTenantIdOrThrow } from '@/lib/activeTenant';

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
    isActive: row.isActive,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

function toHistoryEntry(row: ProductSupplierPriceHistoryRow): ProductSupplierPriceHistory {
  return {
    id: row.id,
    productId: row.productId,
    supplierId: row.supplierId,
    purchasePrice: row.purchasePrice,
    isPreferred: row.isPreferred,
    recordedAt: row.recordedAt,
    syncedAt: row.syncedAt ?? undefined,
  };
}

/** Implementação do SupplierRepository sobre Drizzle + expo-sqlite (Plano B). */
export class DrizzleSupplierRepository implements SupplierRepository {
  async list(): Promise<Supplier[]> {
    // Só a empresa ativa (isolamento do SQLite compartilhado no aparelho).
    const tenantId = getActiveTenantId();
    if (!tenantId) return [];
    const rows = await db.select().from(suppliers).where(eq(suppliers.tenantId, tenantId));
    return rows.map(toSupplier);
  }

  async getById(id: string): Promise<Supplier | null> {
    const tenantId = getActiveTenantId();
    if (!tenantId) return null;
    const rows = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, id), eq(suppliers.tenantId, tenantId)));
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
      tenantId: getActiveTenantIdOrThrow(),
      needsSync: true,
    });
    return { id, ...input, needsSync: true };
  }

  async update(id: string, patch: Partial<Supplier>): Promise<void> {
    const set: Partial<SupplierPatch> = { needsSync: true, tenantId: getActiveTenantIdOrThrow() };
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

  // Telas de uso só veem vínculos ATIVOS e não marcados p/ exclusão.
  async listLinks(supplierId: string): Promise<ProductSupplier[]> {
    const rows = await db
      .select()
      .from(productSuppliers)
      .where(
        and(
          eq(productSuppliers.supplierId, supplierId),
          eq(productSuppliers.isActive, true),
          eq(productSuppliers.pendingDelete, false),
        ),
      );
    return rows.map(toLink);
  }

  async listLinksByProduct(productId: string): Promise<ProductSupplier[]> {
    const rows = await db
      .select()
      .from(productSuppliers)
      .where(
        and(
          eq(productSuppliers.productId, productId),
          eq(productSuppliers.isActive, true),
          eq(productSuppliers.pendingDelete, false),
        ),
      );
    return rows.map(toLink);
  }

  // Reativa o vínculo se ele já existir (mesmo par produto/fornecedor), preservando
  // o id/client_id e o histórico; caso contrário insere um novo. Espelha a unique
  // (product, supplier) do servidor, evitando duplicata local ao re-adicionar.
  async addLink(input: NewProductSupplier): Promise<void> {
    const tenantId = getActiveTenantIdOrThrow();
    const existing = await db
      .select()
      .from(productSuppliers)
      .where(
        and(
          eq(productSuppliers.productId, input.productId),
          eq(productSuppliers.supplierId, input.supplierId),
        ),
      );
    if (existing.length) {
      await db
        .update(productSuppliers)
        .set({
          purchasePrice: input.purchasePrice,
          isPreferred: input.isPreferred ?? existing[0].isPreferred,
          isActive: true,
          pendingDelete: false,
          tenantId,
          needsSync: true,
        })
        .where(eq(productSuppliers.id, existing[0].id));
      return;
    }
    await db.insert(productSuppliers).values({
      id: Crypto.randomUUID(),
      productId: input.productId,
      supplierId: input.supplierId,
      purchasePrice: input.purchasePrice,
      isPreferred: input.isPreferred ?? false,
      tenantId,
      needsSync: true,
    });
  }

  async updateLink(
    id: string,
    patch: { purchasePrice?: number; isPreferred?: boolean },
  ): Promise<void> {
    const set: Partial<ProductSupplierPatch> = { needsSync: true, tenantId: getActiveTenantIdOrThrow() };
    if (patch.purchasePrice !== undefined) set.purchasePrice = patch.purchasePrice;
    if (patch.isPreferred !== undefined) set.isPreferred = patch.isPreferred;
    await db.update(productSuppliers).set(set).where(eq(productSuppliers.id, id));
  }

  // Inativa (soft): o sync propaga is_active=false; o vínculo continua guardado.
  async inactivateLink(id: string): Promise<void> {
    await db
      .update(productSuppliers)
      .set({ isActive: false, tenantId: getActiveTenantIdOrThrow(), needsSync: true })
      .where(eq(productSuppliers.id, id));
  }

  // Exclusão definitiva: marca p/ o sync apagar no servidor e depois remover local.
  async deleteLink(id: string): Promise<void> {
    await db
      .update(productSuppliers)
      .set({ pendingDelete: true, tenantId: getActiveTenantIdOrThrow(), needsSync: true })
      .where(eq(productSuppliers.id, id));
  }

  async listPriceHistory(productId: string, limit: number): Promise<ProductSupplierPriceHistory[]> {
    const rows = await db
      .select()
      .from(productSupplierPriceHistory)
      .where(eq(productSupplierPriceHistory.productId, productId))
      .orderBy(desc(productSupplierPriceHistory.recordedAt))
      .limit(limit);
    return rows.map(toHistoryEntry);
  }
}

type ProductSupplierPatch = {
  purchasePrice: number;
  isPreferred: boolean;
  tenantId: string;
  needsSync: boolean;
};

type SupplierPatch = {
  name: string;
  contactName: string | null;
  phone: string | null;
  address: string | null;
  tenantId: string;
  needsSync: boolean;
};
