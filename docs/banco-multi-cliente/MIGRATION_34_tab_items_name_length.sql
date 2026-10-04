-- =====================================================================
-- MIGRATION 34 — tab_items.name acompanha o tamanho de products.name
-- Idempotente.
--
-- MOTIVAÇÃO:
--   tab_items.name é o snapshot do nome do produto no momento em que ele entra
--   na comanda, mas era varchar(120), enquanto products.name é varchar(200).
--   Produtos cadastrados antes da validação de 120 caracteres no app podem ter
--   nomes entre 121 e 200 — ao adicionar um desses à comanda, o banco recusava
--   o insert com 22001 ("value too long for type character varying(120)").
--
-- DECISÃO:
--   Ampliar a coluna para varchar(200), igual à de products. Ampliar um varchar
--   é só mudança de metadados (sem reescrever a tabela).
-- =====================================================================

alter table public.tab_items alter column name type varchar(200);
