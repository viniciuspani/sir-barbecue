import { eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { products, type ProductRow } from '@/data/local/schema';
import type { Product } from '@/domain/entities/Product';
import type { ProductRepository } from '@/domain/repositories/ProductRepository';

// visible_days é persistido como JSON de números (0..6). Vazio/null = todos os dias.
function serializeDays(days?: number[]): string | null {
  return days && days.length > 0 ? JSON.stringify(days) : null;
}

function parseDays(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    // valor corrompido → trata como "todos os dias"
  }
  return undefined;
}

function toEntity(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    isActive: row.isActive,
    categoryId: row.categoryId ?? undefined,
    visibleDays: parseDays(row.visibleDays),
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

/**
 * Implementação do ProductRepository sobre Drizzle + expo-sqlite (Plano B).
 * A interface no domínio é idêntica à do WatermelonDB — Presentation/Use Cases não mudam.
 */
export class DrizzleProductRepository implements ProductRepository {
  async list(): Promise<Product[]> {
    const rows = await db.select().from(products);
    return rows.map(toEntity);
  }

  async getById(id: string): Promise<Product | null> {
    const rows = await db.select().from(products).where(eq(products.id, id));
    return rows.length ? toEntity(rows[0]) : null;
  }

  async create(input: Omit<Product, 'id' | 'needsSync' | 'syncedAt'>): Promise<Product> {
    const id = Crypto.randomUUID();
    await db.insert(products).values({
      id,
      name: input.name,
      price: input.price,
      isActive: input.isActive,
      categoryId: input.categoryId ?? null,
      visibleDays: serializeDays(input.visibleDays),
      needsSync: true,
    });
    return {
      id,
      name: input.name,
      price: input.price,
      isActive: input.isActive,
      categoryId: input.categoryId,
      visibleDays: input.visibleDays,
      needsSync: true,
    };
  }

  async update(id: string, patch: Partial<Product>): Promise<void> {
    const set: Partial<NewProductPatch> = { needsSync: true };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.price !== undefined) set.price = patch.price;
    if (patch.isActive !== undefined) set.isActive = patch.isActive;
    if (patch.categoryId !== undefined) set.categoryId = patch.categoryId ?? null;
    if (patch.visibleDays !== undefined) set.visibleDays = serializeDays(patch.visibleDays);
    await db.update(products).set(set).where(eq(products.id, id));
  }

  observeAll(onChange: (items: Product[]) => void): () => void {
    // Reatividade via change listener do expo-sqlite (substitui os observables do WDB).
    const emit = () => {
      this.list().then(onChange).catch(() => undefined);
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'products') emit();
    });
    return () => subscription.remove();
  }
}

type NewProductPatch = {
  name: string;
  price: number;
  isActive: boolean;
  categoryId: string | null;
  visibleDays: string | null;
  needsSync: boolean;
};
