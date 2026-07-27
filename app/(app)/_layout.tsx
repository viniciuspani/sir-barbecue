import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { View } from 'react-native';

import { colors } from '@/design/tokens';
import { usePermissions } from '@/lib/permissions';
import { useAuthStore } from '@/store/authStore';
import { OfflineBanner } from '@/ui/OfflineBanner';
import { Splash } from '@/ui/Splash';

/**
 * Grupo autenticado: gate de sessão + banner offline + bottom tabs.
 * As abas Início/Produtos/Estoque só aparecem para owner/manager (RBAC); o
 * employee (caixa) fica com Venda e Mais. A RLS do servidor é a barreira real.
 */
export default function AppLayout() {
  const authenticated = useAuthStore((s) => s.session != null || s.devAuthenticated);
  const initializing = useAuthStore((s) => s.initializing);
  const { canAccessHome, canAccessProducts, canAccessStock } = usePermissions();

  if (initializing) return <Splash />;
  if (!authenticated) return <Redirect href="/(auth)/login" />;

  return (
    <View style={styles.root}>
      <OfflineBanner />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.gold,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.divider },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Início',
            href: canAccessHome ? undefined : null,
            tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="venda"
          options={{
            title: 'Venda',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="add-circle-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="produtos"
          options={{
            title: 'Produtos',
            href: canAccessProducts ? undefined : null,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="fast-food-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="estoque"
          options={{
            title: 'Estoque',
            href: canAccessStock ? undefined : null,
            tabBarIcon: ({ color, size }) => <Ionicons name="cube-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="mais"
          options={{
            title: 'Mais',
            tabBarIcon: ({ color, size }) => <Ionicons name="menu-outline" color={color} size={size} />,
          }}
        />
      </Tabs>
    </View>
  );
}

const styles = { root: { flex: 1, backgroundColor: colors.bg } } as const;
