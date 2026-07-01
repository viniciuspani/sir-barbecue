import { defineConfig } from 'drizzle-kit';

// Config do drizzle-kit (geração de migrations). Quando o schema crescer:
//   npx drizzle-kit generate   → gera ./drizzle/*.sql
// Na Fase 0 o schema é criado direto em src/data/local/database.ts.
export default defineConfig({
  schema: './src/data/local/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  driver: 'expo',
});
