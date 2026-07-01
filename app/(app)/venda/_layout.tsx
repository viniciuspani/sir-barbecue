import { Stack } from 'expo-router';

import { colors } from '@/design/tokens';

// Stack aninhada na tab "Venda": Nova Venda → Fechar Venda.
export default function VendaLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
