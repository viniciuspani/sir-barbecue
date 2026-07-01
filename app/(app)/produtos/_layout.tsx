import { Stack } from 'expo-router';

import { colors } from '@/design/tokens';

// Stack aninhada na tab "Produtos": lista → form (criar/editar).
export default function ProdutosLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
