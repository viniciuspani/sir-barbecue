import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';

import schema from './schema';
import ProductModel from './models/Product';

// Adapter SQLite com JSI — `jsi: true` é a chave da New Architecture (SDK 55).
const adapter = new SQLiteAdapter({
  schema,
  jsi: true,
  onSetUpError: (error) => {
    // Se isto disparar no spike, o gate falhou → acionar Plano B (expo-sqlite + Drizzle).
    console.error('[WatermelonDB] erro de setup', error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [ProductModel],
});
