// Design tokens — porta direta do :root de docs/design/telas_la_brasa.html.
// Fonte da verdade visual do app (tema escuro).

export const colors = {
  bg: '#1A1A1A', // --bg-primary
  surface: '#252525', // --surface
  surfaceHover: '#2E2E2E', // --surface-hover
  gold: '#D4A017', // --gold (cor de marca)
  goldLight: '#E8BA2A', // --gold-light
  red: '#8B1E1E', // --red
  redHover: '#A32323', // --red-hover
  green: '#27AE60', // --green (sucesso / sync ok)
  yellow: '#F39C12', // --yellow (alerta)
  danger: '#E74C3C', // progress-red
  divider: '#333333', // --divider
  textPrimary: '#FFFFFF', // --text-primary
  textSecondary: '#B0B0B0', // --text-secondary
  onGold: '#000000', // texto sobre botão dourado
} as const;

export const radii = { sm: 8, md: 12, lg: 16, xl: 20, pill: 100 } as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 20, xl: 24, xxl: 32 } as const;

// Escala respeitando RNF-05 (corpo >= 16sp, ações >= 18sp).
export const fontSizes = {
  caption: 12,
  label: 14,
  body: 16,
  action: 18,
  title: 20,
  display: 28,
} as const;

export type AppColors = typeof colors;
