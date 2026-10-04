-- =====================================================================
-- MIGRATION 32 — reports.type aceita 'period_sales'
-- Idempotente.
--
-- MOTIVAÇÃO:
--   O filtro de relatório ganhou "Esta semana" e "Personalizado" (período
--   livre, escolhido pela pessoa) além de Hoje/Mês. Nenhum dos dois é
--   "diário" nem "mensal", então generate-report passou a mandar
--   type: 'period_sales' para eles — valor que reports_type_check (criado em
--   SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql) não conhecia:
--     new row for relation "reports" violates check constraint "reports_type_check"
--   Todo relatório fora de Hoje/Mês passou a falhar com 400 ao gerar.
-- =====================================================================

alter table public.reports drop constraint if exists reports_type_check;
alter table public.reports add constraint reports_type_check
  check (type in ('daily_sales','monthly_sales','period_sales','products_sold','financial_summary'));
