import { Ionicons } from '@expo/vector-icons';
import { type Href, Redirect, Tabs, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { colors } from '@/design/tokens';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { hasSeenWelcome, markWelcomeSeen } from '@/services/onboarding';
import { DEFAULT_TENANT_NAME, fetchTenant } from '@/services/tenant';
import { useAuthStore } from '@/store/authStore';
import { MembershipRequired } from '@/ui/MembershipRequired';
import { OfflineBanner } from '@/ui/OfflineBanner';
import { Splash } from '@/ui/Splash';

// Rota do passo de boas-vindas (cast até o typegen do expo-router reconhecê-la).
const WELCOME_ROUTE = '/boas-vindas' as Href;

/**
 * Grupo autenticado: gate de sessão + banner offline + bottom tabs.
 * As abas Início/Produtos/Estoque só aparecem para owner/manager (RBAC); o
 * employee (caixa) fica com Venda e Mais. A RLS do servidor é a barreira real.
 */
export default function AppLayout() {
  const router = useRouter();
  const authenticated = useAuthStore((s) => s.session != null || s.devAuthenticated);
  const devAuthenticated = useAuthStore((s) => s.devAuthenticated);
  const initializing = useAuthStore((s) => s.initializing);
  const membershipStatus = useAuthStore((s) => s.membershipStatus);
  const userId = useAuthStore((s) => s.user?.id);
  const currentTenantId = useAuthStore((s) => s.currentTenantId);
  const { canAccessHome, canAccessProducts, canAccessStock, role } = usePermissions();
  const welcomeChecked = useRef(false);

  // Boas-vindas do 1º login (uma vez por usuário/aparelho — flag local):
  //  - OWNER com a empresa ainda "Minha Empresa" (recém-cadastrado) → tela p/ nomear
  //    o negócio. Se já nomeou, nada.
  //  - CONVIDADO (manager/employee) → só uma saudação; ele já entrou numa empresa
  //    existente e nomeada, então NÃO faz sentido a tela de nome.
  useEffect(() => {
    if (membershipStatus !== 'member' || !userId || !currentTenantId || welcomeChecked.current) {
      return;
    }
    welcomeChecked.current = true;
    void (async () => {
      if (await hasSeenWelcome(userId)) return;
      await markWelcomeSeen(userId);
      const tenant = await fetchTenant(currentTenantId).catch(() => null);
      if (role === 'owner') {
        if (!tenant || tenant.name === DEFAULT_TENANT_NAME) router.push(WELCOME_ROUTE);
      } else {
        showToast(
          tenant?.name ? `Bem-vindo(a) à equipe de ${tenant.name}! 🔥` : 'Bem-vindo(a) à equipe! 🔥',
        );
      }
    })();
  }, [membershipStatus, userId, currentTenantId, role, router]);

  if (initializing) return <Splash />;
  if (!authenticated) return <Redirect href="/(auth)/login" />;

  // Trava de acesso por vínculo (o dev bypass não passa por resolução de empresa).
  // Sem vínculo → bloqueia; enquanto resolve → splash (evita flash da Venda).
  if (!devAuthenticated) {
    if (membershipStatus === 'resolving') return <Splash />;
    if (membershipStatus === 'none') return <MembershipRequired />;
  }

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
