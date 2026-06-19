# Arquitetura de Banco de Dados — Sir Barbecue

> **Fase:** 2 de 2 — Índices, Transações, Sync Offline, Backup, Migrations, Queries, Segurança e Monitoramento
> **Versão:** 1.0
> **Data:** 07/06/2026
> **Elaborado por:** Arquiteto de Soluções (gerado via /arquiteto-solucoes-sistema)
> **Baseado em:** Designing Data-Intensive Applications — Martin Kleppmann
> **Documento anterior:** [02a_ARQUITETURA_BD_MODELO_DADOS.md](./02a_ARQUITETURA_BD_MODELO_DADOS.md)

---

## Índice desta Fase

5. [Estratégia de Índices](#5-estratégia-de-índices)
6. [Transações e Controle de Concorrência](#6-transações-e-controle-de-concorrência)
7. [Consistência e Modelo CAP](#7-consistência-e-modelo-cap)
8. [Sincronização Offline — Modelo de Dados](#8-sincronização-offline--modelo-de-dados)
9. [Estratégia de Backup e Recuperação](#9-estratégia-de-backup-e-recuperação)
10. [Migrations e Evolução do Schema](#10-migrations-e-evolução-do-schema)
11. [Otimização de Queries Críticas](#11-otimização-de-queries-críticas)
12. [Connection Pooling](#12-connection-pooling)
13. [Segurança do Banco de Dados](#13-segurança-do-banco-de-dados)
14. [Monitoramento do Banco de Dados](#14-monitoramento-do-banco-de-dados)

---

## 5. Estratégia de Índices

> **Referência DDIA:** Cap. 3 (Storage and Retrieval) — Kleppmann explica B-Trees vs LSM-Trees e como índices afetam performance de leitura e escrita.

### 5.1 Índices por Tabela

**Tabela: `sales`** — tabela mais consultada nos relatórios

```sql
-- Índice principal: busca por usuário + data (toda query de relatório usa isso)
CREATE INDEX idx_sales_user_date ON sales(user_id, sale_date DESC)
WHERE deleted_at IS NULL;

-- Índice para filtrar por forma de pagamento (relatório diário RF-17)
CREATE INDEX idx_sales_user_payment ON sales(user_id, payment_method, sale_date);

-- Índice para sync: encontrar vendas não sincronizadas rapidamente
CREATE INDEX idx_sales_not_synced ON sales(user_id, synced_at)
WHERE synced_at IS NULL;
```

**Tabela: `sale_items`** — consultada em todos os relatórios de produto

```sql
-- Índice para JOIN com sales (mais usado)
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

-- Índice para relatório de produtos vendidos (RF-19, RF-20)
CREATE INDEX idx_sale_items_product ON sale_items(product_id);
```

**Tabela: `stock_items`** — leitura frequente na tela de estoque e vendas

```sql
-- Listagem do dashboard de estoque
CREATE INDEX idx_stock_items_user ON stock_items(user_id);

-- Alerta de estoque baixo: produtos abaixo do threshold
CREATE INDEX idx_stock_items_alert ON stock_items(user_id, quantity, alert_threshold)
WHERE alert_threshold > 0;
```

**Tabela: `products`** — listagem na tela de vendas

```sql
-- Listagem de produtos ativos por usuário
CREATE INDEX idx_products_user_active ON products(user_id, is_active, category_id)
WHERE is_active = true;
```

**Tabela: `product_suppliers`** — usada nos cálculos de margem

```sql
-- JOIN para custo de produto nos relatórios
CREATE INDEX idx_product_suppliers_product ON product_suppliers(product_id, is_preferred);
```

### 5.2 Justificativa e Trade-offs

| Índice | Query que otimiza | Custo de escrita | Benefício |
|--------|------------------|-----------------|-----------|
| `idx_sales_user_date` | `WHERE user_id = ? ORDER BY sale_date DESC` | Baixo | Elimina seq scan em todas as queries de relatório |
| `idx_sale_items_sale` | `JOIN sale_items ON sale_id` | Baixo | JOIN O(log n) ao invés de seq scan |
| `idx_stock_items_alert` | Verificação de alertas de estoque | Baixíssimo | Evita scan de toda a tabela |
| `idx_products_user_active` | Tela de vendas — listar produtos ativos | Baixo | Partial index: só indexa registros ativos |

### 5.3 O que NÃO indexar em v1

- Colunas com 2–3 valores distintos em tabelas pequenas (ex: `consumption_mode` em < 100K registros)
- Tabelas com < 100 registros (`categories`, `suppliers`) — seq scan é mais rápido
- `client_id` em `sales` já tem UNIQUE constraint (implica índice)

---

## 6. Transações e Controle de Concorrência

> **Referência DDIA:** Cap. 7 — Kleppmann desmistifica ACID, níveis de isolamento e write skew.

### 6.1 Nível de Isolamento

**Padrão configurado:** `READ COMMITTED` (padrão do PostgreSQL)

**Justificativa:** Volume muito baixo (1 usuário, ~5 operações/minuto). READ COMMITTED é suficiente para a maioria das operações. SERIALIZABLE apenas em operações de estoque críticas.

### 6.2 Transações por Fluxo Crítico

**Fluxo: Registro de Venda (operação crítica — RF-12 + RF-10)**

```sql
BEGIN;

-- 1. Inserir a venda
INSERT INTO sales (user_id, total_amount, payment_method, consumption_mode, sale_date, client_id)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (client_id) DO NOTHING  -- idempotência para sync offline
RETURNING id;

-- 2. Inserir os itens (dispara trigger de dedução de estoque)
INSERT INTO sale_items (sale_id, product_id, quantity, unit_price)
VALUES
    ($sale_id, $product_id_1, $qty_1, $price_1),
    ($sale_id, $product_id_2, $qty_2, $price_2);
-- Trigger trg_deduct_stock_on_sale executa automaticamente para cada item

COMMIT;
-- Em caso de qualquer erro: ROLLBACK automático
-- Garante: ou venda + itens + dedução de estoque acontecem juntos, ou nada
```

**Fluxo: Entrada de Estoque (RF-09)**

```sql
BEGIN;

INSERT INTO stock_entries (product_id, supplier_id, user_id, quantity, unit_cost, client_id)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (client_id) DO NOTHING;
-- Trigger trg_increment_stock_on_entry executa automaticamente

COMMIT;
```

### 6.3 Proteção contra Race Conditions

Com um único usuário em v1, race conditions são praticamente impossíveis. Mas as proteções abaixo valem para o caso de múltiplos devices da mesma conta em v2:

| Cenário | Proteção |
|---------|---------|
| Mesma venda enviada duas vezes (retry de sync) | `UNIQUE (client_id)` + `ON CONFLICT DO NOTHING` |
| Mesmo estoque decrementado duas vezes | `client_id` em `sale_items` via `sale_id` — ON CONFLICT na venda pai bloqueia os itens |
| Saldo negativo de estoque | CHECK `quantity >= 0` na tabela `stock_items` |

---

## 7. Consistência e Modelo CAP

> **Referência DDIA:** Cap. 9 — o teorema CAP e as garantias reais que sistemas oferecem.

### 7.1 Posicionamento CAP do Sistema

**Escolha:** CP (Consistência + Tolerância a Partição) para o banco remoto (PostgreSQL/Supabase)

**Comportamento em partição de rede:**
- App Mobile: opera em modo AP (Disponibilidade + Tolerância a Partição) via WatermelonDB local
- Supabase PostgreSQL: CP — em caso de problema de rede, o servidor não aceita escritas inconsistentes
- Resolução: ao reconectar, dados offline são reconciliados com as regras definidas na Fase 1 do documento de software

### 7.2 Garantias por Domínio

| Domínio | Garantia | Implementação |
|---------|---------|---------------|
| Vendas | Read-your-writes | Escrita no local primeiro; leitura local imediata |
| Estoque | Linearizabilidade (server) | Triggers garantem consistência no PostgreSQL; eventual no offline |
| Relatórios | Eventual | Gerado sobre snapshot de dados do servidor |
| Catálogo (produtos) | Eventual | Sync bidirecional com last-writer-wins |

---

## 8. Sincronização Offline — Modelo de Dados

> **Referência DDIA:** Cap. 5 (Replicação) — o dispositivo age como réplica follower; o servidor como single leader.

### 8.1 Controle de Versão para Sync

Todas as tabelas sincronizáveis utilizam `updated_at` como vetor de versão para o protocolo de sync:

```sql
-- O Sync Engine usa updated_at para detectar mudanças desde o último sync
-- Pull do servidor: WHERE updated_at > last_sync_timestamp AND user_id = ?
-- Push ao servidor: inclui updated_at local para comparação

-- Protocolo de sync simplificado:
-- 1. App envia: { table, client_id, updated_at, payload }
-- 2. Servidor: IF server_record.updated_at < client_updated_at → aceita (client wins para vendas)
--              IF server_record.updated_at >= client_updated_at → server wins (para catálogo)
```

### 8.2 Tabela de Controle de Sync (opcional — para sync robusto)

Para uma implementação robusta do sync bidirecional em v2, sugere-se uma tabela de checkpoint:

```sql
CREATE TABLE sync_checkpoints (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES auth.users(id),
    device_id       VARCHAR(100) NOT NULL,
    -- Identificador único do dispositivo
    table_name      VARCHAR(100) NOT NULL,
    last_synced_at  TIMESTAMP   NOT NULL DEFAULT NOW(),

    CONSTRAINT sync_checkpoints_unique UNIQUE (user_id, device_id, table_name)
);
```

### 8.3 Estratégia de Idempotência por Tabela

| Tabela | Chave de Idempotência | SQL de Upsert |
|--------|----------------------|---------------|
| `sales` | `client_id` (UNIQUE) | `ON CONFLICT (client_id) DO NOTHING` |
| `stock_entries` | `client_id` (UNIQUE) | `ON CONFLICT (client_id) DO NOTHING` |
| `products` | `(user_id, name)` (UNIQUE) | `ON CONFLICT (user_id, name) DO UPDATE SET ...` |
| `product_day_visibility` | `(product_id, day_of_week)` (UNIQUE) | `ON CONFLICT (...) DO UPDATE SET is_visible = EXCLUDED.is_visible` |
| `stock_items` | `product_id` (UNIQUE) | `ON CONFLICT (product_id) DO UPDATE SET quantity = ...` |

---

## 9. Estratégia de Backup e Recuperação

> **Referência DDIA:** Cap. 1 — Kleppmann inclui durabilidade como pilar da confiabilidade.

### 9.1 Política de Backup

| Tipo | Frequência | Retenção | Destino |
|------|-----------|---------|---------|
| Full backup automático (Supabase) | Diário | 7 dias (free tier) / 30 dias (Pro) | Supabase managed storage |
| WAL archiving (PITR) | Contínuo | 7 dias (Pro tier) | Supabase managed storage |
| Export manual (pg_dump) | Mensal (recomendado) | Indefinido | Google Drive / local |

### 9.2 Objetivos de Recuperação

| Métrica | Valor | Estratégia |
|---------|-------|-----------|
| RPO (Recovery Point Objective) | < 24h (free tier) / < 1min (Pro PITR) | Backup diário automático |
| RTO (Recovery Time Objective) | < 4h | Restore via Supabase Dashboard |

### 9.3 Retenção de Dados Fiscais (RNF-11)

**Requisito:** dados de vendas retidos por mínimo 5 anos (obrigação fiscal).

**Estratégia:**
- Dados permanecem na tabela `sales` e `sale_items` — sem deleção automática
- Soft delete não aplicado a vendas (apenas a produtos/fornecedores)
- Em v2, quando volume crescer: implementar particionamento por ano em `sales` para facilitar retenção
- Export anual em CSV/JSON para armazenamento independente do provedor como segurança adicional

```sql
-- Script de export anual de vendas (executar no final de cada ano)
COPY (
    SELECT s.*, si.product_id, si.quantity, si.unit_price, si.subtotal
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE s.sale_date >= '2026-01-01' AND s.sale_date < '2027-01-01'
    AND s.user_id = '<user_uuid>'
) TO '/tmp/sales_2026.csv' CSV HEADER;
```

---

## 10. Migrations e Evolução do Schema

> **Referência DDIA:** Cap. 4 — forward e backward compatibility em schemas.

### 10.1 Ferramenta de Migration

**Ferramenta:** Supabase CLI + arquivos SQL versionados

**Convenção de nomenclatura:**
```
supabase/migrations/
  20260607000001_initial_schema.sql
  20260607000002_create_products_table.sql
  20260607000003_add_client_id_to_sales.sql
  20260607000004_create_sync_checkpoints.sql
```

**Comandos:**
```bash
# Criar nova migration
supabase migration new add_product_images

# Aplicar migrations em desenvolvimento
supabase db push

# Aplicar em produção via CI/CD
supabase db push --db-url $SUPABASE_DB_URL
```

### 10.2 Boas Práticas de Migration

**Sempre fazer:**
- Migrations aditivas no MVP: `ADD COLUMN`, `ADD TABLE`, `ADD INDEX`
- Testar migration em staging antes de produção
- Usar `IF NOT EXISTS` para idempotência das migrations
- `ADD COLUMN ... DEFAULT value` em PostgreSQL 11+ é O(1) — não reescreve a tabela

**Evitar:**
- `DROP COLUMN` sem período de deprecação (pelo menos 1 sprint de aviso)
- `ALTER COLUMN TYPE` em tabelas grandes com dados sem período de migração gradual
- Renomear colunas diretamente (adicionar nova → migrar dados → remover antiga após 1 deploy)

### 10.3 Migration Inicial — Seed de Categorias Padrão

```sql
-- Inserir categorias padrão após criação do usuário (via trigger ou onboarding)
-- As categorias são globais (user_id do proprietário) — definidas no onboarding

-- Exemplo de seed de visibilidade padrão do feijão tropeiro
-- (sextas-feiras = dia_of_week = 5)
INSERT INTO product_day_visibility (product_id, day_of_week, is_visible)
SELECT
    p.id,
    generate_series(0, 6) AS day_of_week,
    CASE
        WHEN p.name ILIKE '%feijão%' OR p.name ILIKE '%tropeiro%'
        THEN (generate_series(0, 6) = 5)  -- apenas sexta
        ELSE true                           -- todos os dias
    END AS is_visible
FROM products p
ON CONFLICT (product_id, day_of_week) DO NOTHING;
```

---

## 11. Otimização de Queries Críticas

> **Referência DDIA:** Cap. 3 — B-Tree indexes, SSTable scans e quando cada abordagem é eficiente.

### 11.1 Query Crítica: Relatório Diário de Vendas (RF-17)

```sql
-- Totalizar vendas do dia por forma de pagamento
SELECT
    payment_method,
    COUNT(*)                AS total_transactions,
    SUM(total_amount)       AS total_revenue
FROM sales
WHERE
    user_id = $1
    AND sale_date >= $date_start      -- ex: '2026-06-07 00:00:00'
    AND sale_date <  $date_end        -- ex: '2026-06-08 00:00:00'
GROUP BY payment_method
ORDER BY payment_method;

-- Índice utilizado: idx_sales_user_date (user_id + sale_date)
-- EXPLAIN ANALYZE esperado: Index Scan (não Seq Scan)
```

### 11.2 Query Crítica: Relatório de Produtos com Margem (RF-19, RF-20)

```sql
-- Produtos vendidos no período com quantidade, receita, custo e margem
SELECT
    p.name                                      AS product_name,
    c.name                                      AS category_name,
    SUM(si.quantity)                            AS total_quantity,
    SUM(si.subtotal)                            AS total_revenue,
    COALESCE(ps.purchase_price, 0)              AS unit_cost,
    COALESCE(ps.purchase_price, 0) * SUM(si.quantity) AS total_cost,
    SUM(si.subtotal) - (COALESCE(ps.purchase_price, 0) * SUM(si.quantity)) AS gross_profit,
    CASE
        WHEN SUM(si.subtotal) > 0
        THEN ROUND(
            ((SUM(si.subtotal) - COALESCE(ps.purchase_price, 0) * SUM(si.quantity))
            / SUM(si.subtotal)) * 100, 2
        )
        ELSE 0
    END AS margin_pct
FROM sale_items si
JOIN sales s         ON s.id = si.sale_id
JOIN products p      ON p.id = si.product_id
JOIN categories c    ON c.id = p.category_id
LEFT JOIN product_suppliers ps
    ON ps.product_id = p.id AND ps.is_preferred = true
WHERE
    s.user_id = $1
    AND s.sale_date >= $date_start
    AND s.sale_date <  $date_end
GROUP BY p.id, p.name, c.name, ps.purchase_price
ORDER BY total_revenue DESC;

-- Índices utilizados: idx_sales_user_date + idx_sale_items_sale + idx_sale_items_product
```

### 11.3 Query Crítica: Dashboard do Mês (RF-27)

```sql
-- Resumo do mês corrente para dashboard
SELECT
    COUNT(DISTINCT s.id)        AS total_sales,
    SUM(s.total_amount)         AS total_revenue,
    AVG(s.total_amount)         AS avg_ticket,
    SUM(si.quantity)            AS total_items_sold,
    -- Custo total (soma dos custos dos itens com fornecedor preferido)
    SUM(si.quantity * COALESCE(ps.purchase_price, 0)) AS total_cost
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
LEFT JOIN product_suppliers ps
    ON ps.product_id = si.product_id AND ps.is_preferred = true
WHERE
    s.user_id = $1
    AND s.sale_date >= date_trunc('month', NOW())
    AND s.sale_date <  date_trunc('month', NOW()) + INTERVAL '1 month';
```

### 11.4 Paginação — Cursor-Based (recomendado para histórico de vendas)

> **Referência DDIA:** Cap. 3 — Kleppmann recomenda cursor-based iteration em vez de offset para grandes datasets.

```sql
-- Ruim (offset): performance degrada em páginas altas
SELECT * FROM sales
WHERE user_id = $1
ORDER BY sale_date DESC
LIMIT 20 OFFSET 10000;

-- Bom (cursor): performance constante
SELECT * FROM sales
WHERE user_id = $1
  AND sale_date < $cursor_date  -- timestamp da última venda da página anterior
ORDER BY sale_date DESC
LIMIT 20;
```

---

## 12. Connection Pooling

**Gerenciado pelo Supabase** — o Supabase utiliza PgBouncer internamente para pooling de conexões.

| Parâmetro | Valor (Supabase Free) | Supabase Pro |
|-----------|----------------------|-------------|
| Max conexões | 60 | 200+ |
| Modo de pool | Transaction mode | Transaction mode |
| Timeout de conexão | 10s | 10s |

**Para o app mobile:** O Supabase SDK usa HTTP (PostgREST) para queries, não conexões diretas ao PostgreSQL — não há risco de connection exhaustion em v1 com 1 usuário.

**Para Edge Functions:** Conexões via pool interno do Deno (máx 5 conexões simultâneas por função) — suficiente para o volume de geração de relatórios.

---

## 13. Segurança do Banco de Dados

### 13.1 Row Level Security (RLS) — Princípio do Menor Privilégio

```sql
-- Verificar se RLS está habilitado em todas as tabelas críticas
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Todas as tabelas devem ter rowsecurity = true
```

**Usuários de banco de dados:**

| Role | Acesso | Uso |
|------|--------|-----|
| `authenticator` | Restrito (PostgREST) | Supabase API — nunca acesso direto ao DB |
| `anon` | Apenas endpoints públicos (auth) | Usuários não autenticados |
| `authenticated` | Tabelas com RLS permitindo `auth.uid()` | Proprietária logada |
| `service_role` | Bypass RLS | Edge Functions apenas — nunca expor ao cliente |

### 13.2 Criptografia

| Dado | Tratamento | Justificativa |
|------|-----------|---------------|
| Senha do usuário | Bcrypt via Supabase Auth — nunca texto plano | Segurança padrão |
| E-mail do proprietário | Armazenado em `auth.users` (gerenciado pelo Supabase) | LGPD — base legal: execução de contrato |
| Dados financeiros em trânsito | TLS 1.3 (Supabase enforça) | RNF-07 |
| Dados em repouso | AES-256 no storage do Supabase | Infraestrutura Supabase |
| Tokens JWT no dispositivo | Keychain (iOS) / Keystore (Android) via expo-secure-store | RNF-07 |
| Dados financeiros locais (SQLite) | Sandbox privado do app | Proteção do SO |

### 13.3 LGPD — Dados do Proprietário

**Dados coletados do proprietário:**
- E-mail (autenticação) — base legal: execução de contrato
- Dados de sessão — base legal: legítimo interesse
- Dados do negócio (vendas, estoque) — base legal: execução de contrato

**Não há dados de clientes** — vendas são anônimas (RF por decisão registrada Q9).

**Mecanismo de exclusão de conta (RNF-08):**

```sql
-- Exclusão de conta a pedido (hard delete de dados pessoais)
-- Executado pela Edge Function de "excluir conta"
DELETE FROM reports WHERE user_id = $user_id;
DELETE FROM stock_entries WHERE user_id = $user_id;
DELETE FROM sales WHERE user_id = $user_id;  -- CASCADE deleta sale_items
DELETE FROM stock_items WHERE user_id = $user_id;
DELETE FROM product_suppliers WHERE product_id IN
    (SELECT id FROM products WHERE user_id = $user_id);
DELETE FROM product_day_visibility WHERE product_id IN
    (SELECT id FROM products WHERE user_id = $user_id);
DELETE FROM products WHERE user_id = $user_id;
DELETE FROM suppliers WHERE user_id = $user_id;
DELETE FROM categories WHERE user_id = $user_id;
-- Supabase Auth deleta o usuário de auth.users
SELECT auth.delete_user($user_id);
```

**Nota:** Para compliance fiscal, os dados de `sales` e `sale_items` devem ser retidos por 5 anos (RNF-11). Em caso de exclusão de conta, avaliar anonimização dos registros ao invés de deleção hard.

### 13.4 Auditoria

```sql
-- Log de auditoria para operações críticas (opcional em v1, recomendado para v2)
CREATE TABLE audit_log (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL,
    table_name  VARCHAR(100) NOT NULL,
    operation   VARCHAR(10)  NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
    record_id   UUID,
    old_data    JSONB,
    new_data    JSONB,
    ip_address  INET,
    created_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);
```

---

## 14. Monitoramento do Banco de Dados

### 14.1 Métricas Essenciais

| Métrica | Como Verificar | Alerta |
|---------|---------------|--------|
| Tamanho total do banco | Supabase Dashboard → Settings → Database | > 400MB (free tier limit: 500MB) |
| Queries lentas (> 1s) | Supabase Dashboard → Reports → Query Performance | Qualquer query > 2s |
| Tamanho das tabelas principais | `pg_total_relation_size()` | `sales` > 100MB |
| Conexões ativas | Supabase Dashboard → Database → Connections | > 50 (free tier max: 60) |
| Replication lag | N/A (Supabase gerencia replicação) | — |
| Autovacuum health | `pg_stat_user_tables.n_dead_tup` | Dead tuples > 20% de live tuples |

### 14.2 Queries Úteis para Monitoramento

```sql
-- Top 10 queries mais lentas (requer pg_stat_statements)
SELECT
    LEFT(query, 100)    AS query_preview,
    calls,
    ROUND(mean_exec_time::numeric, 2) AS avg_ms,
    ROUND(total_exec_time::numeric, 2) AS total_ms
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Tamanho de cada tabela
SELECT
    relname                             AS table_name,
    pg_size_pretty(pg_total_relation_size(oid)) AS total_size,
    pg_size_pretty(pg_relation_size(oid))       AS table_size,
    pg_size_pretty(pg_indexes_size(oid))        AS indexes_size
FROM pg_class
WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
ORDER BY pg_total_relation_size(oid) DESC;

-- Verificar tabelas com muitos dead tuples (candidatas a VACUUM)
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 100
ORDER BY dead_pct DESC;

-- Verificar alertas de estoque baixo
SELECT
    p.name          AS produto,
    si.quantity     AS estoque_atual,
    si.alert_threshold AS limite_alerta
FROM stock_items si
JOIN products p ON p.id = si.product_id
WHERE si.quantity <= si.alert_threshold
  AND si.alert_threshold > 0
  AND p.is_active = true;
```

### 14.3 Dashboard Sugerido

- **Supabase Dashboard → Reports:** query performance, database size, connections
- **Sentry:** erros no app que envolvem queries (timeout, constraint violations)
- **Alertas manuais:** revisão mensal do tamanho do banco para planejamento de upgrade de tier

---

*Documento gerado via `/arquiteto-solucoes-sistema` — Claude Code Architecture Skill*
*Baseado em: Designing Data-Intensive Applications — Martin Kleppmann (1ª e 2ª ed.)*
