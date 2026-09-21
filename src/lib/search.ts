// Busca por texto tolerante a acento/caixa — usada nos filtros de produto
// (Registrar entrada, Associar produto do fornecedor).

/** Remove acentos e normaliza para minúsculas, para comparação de busca. */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** `haystack` contém `query`, ignorando acento/caixa. Query vazia sempre bate. */
export function matchesSearch(haystack: string, query: string): boolean {
  const q = normalizeSearch(query.trim());
  if (!q) return true;
  return normalizeSearch(haystack).includes(q);
}
