import { Stack } from 'expo-router';

import { colors } from '@/design/tokens';

// Stack da aba "Mais" (hub de configurações). Header dá título + botão voltar automáticos.
export default function MaisLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.gold,
        headerTitleStyle: { color: colors.textPrimary },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Mais' }} />
      <Stack.Screen name="perfil" options={{ title: 'Conta' }} />
      <Stack.Screen name="empresa" options={{ title: 'Minha Empresa' }} />
      <Stack.Screen name="fornecedores" options={{ title: 'Fornecedores' }} />
      <Stack.Screen name="fornecedor-form" options={{ title: 'Fornecedor' }} />
      <Stack.Screen name="fornecedor-detalhe" options={{ title: 'Fornecedor' }} />
      <Stack.Screen name="relatorios" options={{ title: 'Relatórios' }} />
      <Stack.Screen name="notificacoes" options={{ title: 'Notificações' }} />
    </Stack>
  );
}
