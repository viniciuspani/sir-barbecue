// Tema semântico — agrega tokens + tipografia + alvos de acessibilidade.
import { MIN_TOUCH_TARGET } from '@/lib/a11y';

import { colors, radii, spacing, fontSizes } from './tokens';
import { fontFamily, textVariants } from './typography';

export const theme = {
  colors,
  radii,
  spacing,
  fontSizes,
  fontFamily,
  textVariants,
  minTouchTarget: MIN_TOUCH_TARGET,
} as const;

export type Theme = typeof theme;
