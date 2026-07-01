import * as Crypto from 'expo-crypto';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db } from '@/data/local/database';
import { categories, type CategoryRow } from '@/data/local/schema';
import type { Category } from '@/domain/entities/Category';
import type { CategoryRepository } from '@/domain/repositories/CategoryRepository';

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
    const rows = await db.select().from(categories);
    return rows.map(toEntity);
  }

  async create(name: string): Promise<Category> {
    const id = Crypto.randomUUID();
    await db.insert(categories).values({ id, name, needsSync: true });
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
