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

// numeric(10,3) no Postgres: precisão 10, escala 3 → só 7 dígitos antes da
// vírgula cabem. Acima disso o banco recusa com "numeric field overflow"
// (22003) — stock_items.quantity, stock_items.alert_threshold, stock_entries.quantity
// e sale_items.quantity usam essa coluna.
export const MAX_QUANTITY_VALUE = 9_999_999.999;

/**
 * Sanitiza a digitação de uma quantidade/limite: mantém só dígitos e o
 * primeiro separador decimal (vírgula ou ponto — normalizado para vírgula),
 * descarta letras e símbolos, tira zeros à esquerda sem sentido e trava em
 * 7 dígitos inteiros + 3 decimais (numeric(10,3)) — o que já garante nunca
 * passar de MAX_QUANTITY_VALUE, mesmo com uma sequência enorme de zeros.
 */
export function sanitizeQuantityInput(text: string): string {
  let raw = '';
  let sawSeparator = false;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') raw += ch;
    else if ((ch === ',' || ch === '.') && !sawSeparator) {
      raw += ',';
      sawSeparator = true;
    }
  }

  const [intPart, decPart] = raw.split(',');
  const trimmedInt = intPart.replace(/^0+(?=\d)/, '').slice(0, 7);
  if (decPart === undefined) return trimmedInt;
  return `${trimmedInt || '0'},${decPart.slice(0, 3)}`;
}

/** Mensagem quando o valor estoura a coluna numeric(10,3) do banco, ou `null` se ok. */
export function quantityValidationMessage(value: number): string | null {
  if (value > MAX_QUANTITY_VALUE) {
    return `Valor muito alto — o máximo é ${formatQuantity(MAX_QUANTITY_VALUE)}.`;
  }
  return null;
}

// numeric(10,2) no Postgres: precisão 10, escala 2 → só 8 dígitos antes da
// vírgula cabem. Acima disso o banco recusa com "numeric field overflow"
// (22003) — products.price e product_suppliers.purchase_price usam essa coluna.
export const MAX_MONEY_VALUE = 99_999_999.99;
const MAX_MONEY_CENTS = Math.round(MAX_MONEY_VALUE * 100);

/**
 * Máscara de digitação de valor financeiro: trata os dígitos como centavos.
 * Ex.: "8" → "0,08", "800" → "8,00", "125050" → "1.250,50". Vírgula automática.
 * Trava em MAX_MONEY_VALUE: digitar além disso não aumenta mais o valor — evita
 * o usuário montar um número que o banco vai recusar (ver moneyValidationMessage).
 */
export function maskMoney(text: string): string {
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  const cents = Math.min(parseInt(digits, 10), MAX_MONEY_CENTS);
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Converte um número já salvo para o formato de edição "1.234,56". */
export function formatMoneyInput(value: number): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Mensagem quando o valor estoura a coluna numeric(10,2) do banco, ou `null` se ok. */
export function moneyValidationMessage(value: number): string | null {
  if (value > MAX_MONEY_VALUE) {
    return `Valor muito alto — o máximo é ${formatBRL(MAX_MONEY_VALUE)}.`;
  }
  return null;
}
