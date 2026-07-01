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

/** Quantidade pt-BR: inteiro sem decimais; fracionário com vírgula (ex.: 2,5). */
export function formatQuantity(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace('.', ',');
}

/**
 * Máscara de digitação de valor financeiro: trata os dígitos como centavos.
 * Ex.: "8" → "0,08", "800" → "8,00", "125050" → "1.250,50". Vírgula automática.
 */
export function maskMoney(text: string): string {
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  const cents = parseInt(digits, 10);
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Converte um número já salvo para o formato de edição "1.234,56". */
export function formatMoneyInput(value: number): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
