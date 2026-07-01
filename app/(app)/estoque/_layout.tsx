import { Stack } from 'expo-router';

import { colors } from '@/design/tokens';

// Stack aninhada na tab "Estoque": lista → registrar entrada / detalhe.
export default function EstoqueLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
