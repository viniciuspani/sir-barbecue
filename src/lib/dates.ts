// Datas pt-BR e dia da semana — base para a visibilidade de produtos por dia (RF-05).

export const WEEKDAYS_PT = [
  'domingo',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
] as const;

export type Weekday = (typeof WEEKDAYS_PT)[number];

/** Dia da semana (pt-BR) de uma data. Default = hoje. */
export function weekdayOf(date: Date = new Date()): Weekday {
  return WEEKDAYS_PT[date.getDay()];
}

export function formatDatePtBR(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

// ── Datas vindas do servidor (ISO) ───────────────────────────────────────────
// Fixadas em America/Sao_Paulo de propósito. O servidor agenda a exclusão às
// 09:00 de Brasília; formatar no fuso do aparelho faria um celular com fuso
// errado (ou viajando) exibir um DIA diferente daquele em que a conta será
// apagada de fato. Aqui a data mostrada é sempre a data em que a coisa acontece.
const TZ = 'America/Sao_Paulo';

/** "28/09/2026" — null/inválido vira "—". */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TZ,
  }).format(d);
}

/** "16/09/2026, às 14:30" — para o prazo de 48h, que é em horas. */
export function formatIsoDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = formatIsoDate(iso);
  const time = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  }).format(d);
  return `${date}, às ${time}`;
}

/**
 * "28 de setembro de 2026" — para `accessibilityLabel`. O TalkBack lê
 * "28/09/2026" como uma sequência de dígitos soltos, e a informação mais
 * importante da tela se perde.
 */
export function formatIsoDateLong(iso: string | null | undefined): string {
  if (!iso) return 'data indefinida';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'data indefinida';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: TZ }).format(d);
}
