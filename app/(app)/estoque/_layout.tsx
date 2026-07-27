import { Redirect, Stack } from 'expo-router';

import { colors } from '@/design/tokens';
import { usePermissions } from '@/lib/permissions';

// Stack aninhada na tab "Estoque": lista → registrar entrada / detalhe.
// Só owner/manager — employee (caixa) não tem acesso (guarda de deep-link; a RLS confirma).
export default function EstoqueLayout() {
  const { canAccessStock } = usePermissions();
  if (!canAccessStock) return <Redirect href="/venda" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
