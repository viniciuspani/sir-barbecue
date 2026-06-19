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
