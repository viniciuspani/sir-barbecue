import { Redirect, Stack } from 'expo-router';

import { colors } from '@/design/tokens';
import { usePermissions } from '@/lib/permissions';

// Stack aninhada na tab "Produtos": lista → form (criar/editar).
// Só owner/manager — employee (caixa) não tem acesso (guarda de deep-link; a RLS confirma).
export default function ProdutosLayout() {
  const { canAccessProducts } = usePermissions();
  if (!canAccessProducts) return <Redirect href="/venda" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
