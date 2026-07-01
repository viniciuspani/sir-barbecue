import { Redirect, Stack } from 'expo-router';

import { colors } from '@/design/tokens';
import { useAuthStore } from '@/store/authStore';

// Grupo de autenticação. Se já autenticado, redireciona para o app.
export default function AuthLayout() {
  const authenticated = useAuthStore((s) => s.session != null || s.devAuthenticated);
  if (authenticated) return <Redirect href="/(app)" />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
