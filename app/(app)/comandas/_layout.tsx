import { Stack } from 'expo-router';

import { colors } from '@/design/tokens';

// Stack aninhada na tab "Comandas" (fila de produção).
export default function ComandasLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
