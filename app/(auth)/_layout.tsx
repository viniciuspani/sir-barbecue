import { type Href, Redirect, Stack } from 'expo-router';

import { colors } from '@/design/tokens';
import { useAuthStore } from '@/store/authStore';

// Rota top-level do reset (cast até o typegen do expo-router reconhecê-la).
const RESET_ROUTE = '/reset-password' as Href;

// Grupo de autenticação. Se já autenticado, redireciona para o app.
export default function AuthLayout() {
  const authenticated = useAuthStore((s) => s.session != null || s.devAuthenticated);
  const passwordRecovery = useAuthStore((s) => s.passwordRecovery);
  // A sessão criada pelo link de "esqueci minha senha" NÃO é um login: enquanto a
  // nova senha não for definida (ou o fluxo cancelado), o destino é a tela de reset.
  if (passwordRecovery) return <Redirect href={RESET_ROUTE} />;
  if (authenticated) return <Redirect href="/(app)" />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
