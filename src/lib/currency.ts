// Formatação de moeda (R$) — pt-BR. Usado em vendas, produtos e relatórios.

export function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

/** Converte uma entrada de texto (ex.: "R$ 8,00" / "8,00") em número. */
export function parseBRL(input: string): number {
  const normalized = input
    .replace(/[^\d.,-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}
