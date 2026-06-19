import { Q } from '@nozbe/watermelondb';
import * as Crypto from 'expo-crypto';

import { database } from '@/data/local/database';
import ProductModel from '@/data/local/models/Product';
import type { Product } from '@/domain/entities/Product';
import type { ProductRepository } from '@/domain/repositories/ProductRepository';

const collection = () => database.get<ProductModel>('products');

function toEntity(m: ProductModel): Product {
  return {
    id: m.clientId,
    name: m.name,
    price: m.price,
    isActive: m.isActive,
    categoryId: m.categoryId,
    needsSync: m.needsSync,
    syncedAt: m.syncedAt,
  };
}

/**
 * Implementação do ProductRepository sobre WatermelonDB.
 * No Plano B (expo-sqlite + Drizzle), só esta classe muda — a interface no domínio permanece.
 */
export class WatermelonProductRepository implements ProductRepository {
  async list(): Promise<Product[]> {
    const rows = await collection().query().fetch();
    return rows.map(toEntity);
  }

  async getById(id: string): Promise<Product | null> {
    const rows = await collection().query(Q.where('client_id', id)).fetch();
    return rows.length ? toEntity(rows[0]) : null;
  }

  async create(input: Omit<Product, 'id' | 'needsSync' | 'syncedAt'>): Promise<Product> {
    const clientId = Crypto.randomUUID();
    let created!: ProductModel;
    await database.write(async () => {
      created = await collection().create((p) => {
        p.clientId = clientId;
        p.name = input.name;
        p.price = input.price;
        p.isActive = input.isActive;
        p.categoryId = input.categoryId;
        p.needsSync = true;
      });
    });
    return toEntity(created);
  }

  async update(id: string, patch: Partial<Product>): Promise<void> {
    const rows = await collection().query(Q.where('client_id', id)).fetch();
    if (!rows.length) return;
    await database.write(async () => {
      await rows[0].update((p) => {
        if (patch.name !== undefined) p.name = patch.name;
        if (patch.price !== undefined) p.price = patch.price;
        if (patch.isActive !== undefined) p.isActive = patch.isActive;
        if (patch.categoryId !== undefined) p.categoryId = patch.categoryId;
        p.needsSync = true;
      });
    });
  }

  observeAll(onChange: (products: Product[]) => void): () => void {
    const subscription = collection()
      .query()
      .observe()
      .subscribe((rows) => onChange(rows.map(toEntity)));
    return () => subscription.unsubscribe();
  }
}
