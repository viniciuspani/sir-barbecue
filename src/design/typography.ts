// Tipografia — Inter (via @expo-google-fonts/inter), carregada no app/_layout com expo-font.
import { fontSizes } from './tokens';

export const fontFamily = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

export const textVariants = {
  display: { fontFamily: fontFamily.bold, fontSize: fontSizes.display },
  title: { fontFamily: fontFamily.semibold, fontSize: fontSizes.title },
  action: { fontFamily: fontFamily.semibold, fontSize: fontSizes.action },
  body: { fontFamily: fontFamily.regular, fontSize: fontSizes.body },
  label: { fontFamily: fontFamily.medium, fontSize: fontSizes.label },
  caption: { fontFamily: fontFamily.regular, fontSize: fontSizes.caption },
} as const;

export type TextVariant = keyof typeof textVariants;
