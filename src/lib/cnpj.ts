// CNPJ alfanumérico (Receita Federal, vigente desde 2026): os 12 primeiros
// caracteres podem ser dígito OU letra maiúscula; os 2 dígitos verificadores
// continuam sempre numéricos. Ver Nota Técnica COCAD/RFB nº 2025/001.

const DV1_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const DV2_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** Remove máscara e caracteres inválidos, em maiúsculas. Não valida tamanho/DV. */
export function unmaskCnpj(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Aplica a máscara AA.AAA.AAA/AAAA-AA enquanto o usuário digita. */
export function formatCnpjInput(value: string): string {
  const clean = unmaskCnpj(value).slice(0, 14);
  let out = '';
  for (let i = 0; i < clean.length; i++) {
    if (i === 2 || i === 5) out += '.';
    else if (i === 8) out += '/';
    else if (i === 12) out += '-';
    out += clean[i];
  }
  return out;
}

// '0'-'9' (48-57) já valem 0-9; 'A'-'Z' (65-90) valem 17-42 nesta tabela — é a
// mesma conta (código ASCII - 48) usada pela Receita para o CNPJ alfanumérico.
function charValue(c: string): number {
  return c.charCodeAt(0) - 48;
}

function checkDigit(chars: string[], weights: number[]): number {
  const sum = chars.reduce((acc, c, i) => acc + charValue(c) * weights[i], 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/**
 * Valida os 14 caracteres (sem máscara) pelo dígito verificador oficial.
 * Aceita letras nas 12 primeiras posições; os 2 últimos dígitos são sempre numéricos.
 */
export function isValidCnpj(raw: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(raw)) return false;
  if (/^(.)\1{13}$/.test(raw)) return false; // ex.: 00000000000000 — formato ok, DV nunca fecha

  const base = raw.slice(0, 12).split('');
  const dv1 = checkDigit(base, DV1_WEIGHTS);
  const dv2 = checkDigit([...base, String(dv1)], DV2_WEIGHTS);
  return raw[12] === String(dv1) && raw[13] === String(dv2);
}

/**
 * Mensagem para o usuário quando `raw` (já sem máscara) não é um CNPJ
 * utilizável, ou `null` quando está OK. Campo vazio é válido — CNPJ é opcional.
 */
export function cnpjValidationMessage(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw.length < 14) return `CNPJ incompleto: são 14 posições (faltam ${14 - raw.length}).`;
  if (!isValidCnpj(raw)) return 'CNPJ inválido — confira os números digitados.';
  return null;
}
