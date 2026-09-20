// Telefone da empresa: exige DDD + 9 dígitos (celular), 11 no total — é o
// formato que o WhatsApp Business e a maioria dos contatos reais usam hoje.

/** Remove tudo que não é dígito, limitado a 11 posições. */
export function unmaskPhone(value: string): string {
  return value.replace(/\D/g, '').slice(0, 11);
}

/** Aplica a máscara (XX) XXXXX-XXXX enquanto o usuário digita. */
export function formatPhoneInput(value: string): string {
  const clean = unmaskPhone(value);
  if (clean.length === 0) return '';
  if (clean.length <= 2) return `(${clean}`;
  if (clean.length <= 6) return `(${clean.slice(0, 2)}) ${clean.slice(2)}`;
  if (clean.length <= 10) return `(${clean.slice(0, 2)}) ${clean.slice(2, 6)}-${clean.slice(6)}`;
  return `(${clean.slice(0, 2)}) ${clean.slice(2, 7)}-${clean.slice(7)}`;
}

/**
 * Mensagem para o usuário quando `raw` (já sem máscara) está incompleto, ou
 * `null` quando está OK. Campo vazio é válido — telefone é opcional.
 */
export function phoneValidationMessage(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw.length < 11) return `Telefone incompleto: são 11 dígitos (faltam ${11 - raw.length}).`;
  return null;
}
