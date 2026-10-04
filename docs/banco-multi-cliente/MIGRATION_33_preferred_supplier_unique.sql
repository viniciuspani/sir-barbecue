-- =====================================================================
-- MIGRATION 33 — Um único fornecedor "atual" (preferido) por produto
-- Idempotente.
--
-- MOTIVAÇÃO:
--   `product_suppliers.is_preferred` já existe e já é o que o relatório de
--   custo/margem e a tela de estoque usam como "fornecedor atual" do produto
--   (ver costOf() em generate-report e pickCurrentCost() no app) — mas NADA
--   impedia duas linhas com is_preferred=true no MESMO produto. Sem nenhuma
--   tela escrevendo nesse campo até agora, isso nunca deu problema visível;
--   agora que o app ganhou um botão "Marcar como atual" (app escreve
--   is_preferred pela primeira vez), a trava precisa existir no banco —
--   não só na lógica do app — para o dado nunca ficar ambíguo (ex.: duas
--   escritas concorrentes em aparelhos diferentes, antes de sincronizar).
--
--   Um fornecedor pode ser "atual" de vários produtos DIFERENTES ao mesmo
--   tempo (ok); o que não pode é dois fornecedores serem "atual" do MESMO
--   produto. Por isso o índice é por product_client_id, não por linha.
-- =====================================================================

drop index if exists public.product_suppliers_one_preferred_per_product;
create unique index product_suppliers_one_preferred_per_product
  on public.product_suppliers (product_client_id)
  where is_preferred;
