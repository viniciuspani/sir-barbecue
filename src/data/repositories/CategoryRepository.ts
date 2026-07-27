import { eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { categories, type CategoryRow } from '@/data/local/schema';
import type { Category } from '@/domain/entities/Category';
import type { CategoryRepository } from '@/domain/repositories/CategoryRepository';
import { getActiveTenantId, getActiveTenantIdOrThrow } from '@/lib/activeTenant';

function toEntity(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    needsSync: row.needsSync,
    syncedAt: row.syncedAt ?? undefined,
  };
}

/** Implementação do CategoryRepository sobre Drizzle + expo-sqlite (Plano B). */
export class DrizzleCategoryRepository implements CategoryRepository {
  async list(): Promise<Category[]> {
    // Só a empresa ativa (isolamento): o SQLite é compartilhado no aparelho e pode
    // conter categorias de outra empresa em cache.
    const tenantId = getActiveTenantId();
    if (!tenantId) return [];
    const rows = await db.select().from(categories).where(eq(categories.tenantId, tenantId));
    return rows.map(toEntity);
  }

  async create(name: string): Promise<Category> {
    const id = Crypto.randomUUID();
    await db.insert(categories).values({ id, name, tenantId: getActiveTenantIdOrThrow(), needsSync: true });
    return { id, name, needsSync: true };
  }

  observeAll(onChange: (items: Category[]) => void): () => void {
    const emit = () => {
      this.list().then(onChange).catch(() => undefined);
    };
    emit();
    const subscription = addDatabaseChangeListener((event) => {
      if (event.tableName === 'categories') emit();
    });
    return () => subscription.remove();
  }
}
