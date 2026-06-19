import { appSchema, tableSchema } from '@nozbe/watermelondb';

// Schema mínimo para o spike da Fase 0 (gate do WatermelonDB).
// As 11 tabelas completas (doc 02a) entram na Fase 3.
// Campos de controle de sync presentes em todos os modelos: client_id / needs_sync / synced_at.
export default appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'products',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'price', type: 'number' },
        { name: 'is_active', type: 'boolean' },
        { name: 'category_id', type: 'string', isOptional: true },
        { name: 'client_id', type: 'string', isIndexed: true },
        { name: 'needs_sync', type: 'boolean' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
  ],
});
